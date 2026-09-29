import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export interface QueueOptions {
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  now?: () => number;
}

export interface IssueEvent {
  deliveryId: string;
  repository: string;
  issueNumber: number;
  eventKind: string;
  payload: unknown;
}

export interface QueueJob extends IssueEvent {
  id: number;
  status: 'queued' | 'running' | 'done' | 'dead';
  attempts: number;
  nextRunAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  /** Authoritative result, committed in the same transaction as `status='done'`. */
  result: unknown | null;
}

export interface OutboxInput {
  kind: 'comment' | 'reaction';
  payload: unknown;
  key?: string | undefined;
}

export interface OutboxEntry extends OutboxInput {
  id: number;
  jobId: number;
  attempts: number;
  leaseToken: string;
}

export interface OutboxRecord extends OutboxInput {
  id: number;
  jobId: number;
  status: 'queued' | 'running' | 'done' | 'dead';
  attempts: number;
  nextRunAt: number;
  leaseToken: string | null;
  lastError: string | null;
}

type SqlRow = Record<string, unknown>;

/** SQLite-backed at-least-once queue. Callers must treat a recovered job as a possible replay. */
export class DurableQueue {
  private readonly db: DatabaseSync;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => number;

  constructor(path: string, options: QueueOptions = {}) {
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 ||
        !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 ||
        !Number.isSafeInteger(this.baseBackoffMs) || this.baseBackoffMs < 0) {
      throw new RangeError('Invalid queue timing or attempt limit');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as SqlRow).user_version);
      if (version > 3) throw new Error(`Queue schema version ${version} is newer than this program`);
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,next_run_at,id);
      CREATE INDEX IF NOT EXISTS jobs_issue ON jobs(repository,issue_number,id,status);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        effect_key TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('comment','reaction')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_claim ON outbox(status,next_run_at,id);
      CREATE TABLE IF NOT EXISTS issue_heads (
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        PRIMARY KEY(repository,issue_number)
      );
      `);
      const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as SqlRow[];
      if (!columns.some(column => column.name === 'effect_key')) {
        this.db.exec('ALTER TABLE outbox ADD COLUMN effect_key TEXT');
      }
      const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as SqlRow[];
      if (!jobColumns.some(column => column.name === 'result_json')) {
        this.db.exec('ALTER TABLE jobs ADD COLUMN result_json TEXT');
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS outbox_key ON outbox(job_id,effect_key)');
      if (version < 3) {
        this.db.exec(`INSERT OR IGNORE INTO issue_heads(repository,issue_number,job_id)
          SELECT repository,issue_number,MAX(id) FROM jobs WHERE status='done'
          GROUP BY repository,issue_number`);
      }
      this.db.exec('PRAGMA user_version = 3');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /** Create a consistent SQLite backup without replacing an existing destination. */
  async backup(path: string): Promise<void> {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await backup(this.db, temporary);
      const file = openSync(temporary, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      linkSync(temporary, path);
      const dir = openSync(directory, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private backoff(attempts: number): number {
    return Math.min(this.baseBackoffMs * 2 ** Math.min(attempts - 1, 20), 86_400_000);
  }

  enqueue(event: IssueEvent, effects: OutboxInput[] = []): number {
    if (!event.deliveryId || !event.repository || !event.eventKind ||
        !Number.isSafeInteger(event.issueNumber) || event.issueNumber < 1) {
      throw new TypeError('Invalid issue event');
    }
    const payload = JSON.stringify(event.payload);
    if (payload === undefined) throw new TypeError('Event payload must be JSON serializable');
    const now = this.now();
    return this.transaction(() => {
      const inserted = this.db.prepare(`INSERT INTO jobs
        (delivery_id,repository,issue_number,event_kind,payload_json,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO NOTHING`)
        .run(event.deliveryId, event.repository, event.issueNumber, event.eventKind, payload, now, now, now);
      const row = this.db.prepare('SELECT id FROM jobs WHERE delivery_id = ?').get(event.deliveryId) as SqlRow;
      if (inserted.changes) this.insertEffects(Number(row.id), effects, now);
      return Number(row.id);
    });
  }

  getJob(id: number): QueueJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? this.toJob(row) : null;
  }

  listJobs(limit = 50): QueueJob[] {
    this.checkLimit(limit);
    return (this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as SqlRow[])
      .map(row => this.toJob(row));
  }

  latestCompleted(repository: string, issueNumber: number): QueueJob | null {
    const row = this.db.prepare(`SELECT j.* FROM issue_heads h JOIN jobs j ON j.id=h.job_id
      WHERE h.repository=? AND h.issue_number=? AND j.status='done'`)
      .get(repository, issueNumber) as SqlRow | undefined;
    return row ? this.toJob(row) : null;
  }

  listOutbox(limit = 50): OutboxRecord[] {
    this.checkLimit(limit);
    return (this.db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(limit) as SqlRow[])
      .map(row => this.toOutbox(row));
  }

  stats(): { jobs: Record<string, number>; outbox: Record<string, number> } {
    const counts = (table: 'jobs' | 'outbox'): Record<string, number> => {
      const result: Record<string, number> = { queued: 0, running: 0, done: 0, dead: 0 };
      for (const row of this.db.prepare(`SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status`).all() as SqlRow[]) {
        result[String(row.status)] = Number(row.count);
      }
      return result;
    };
    return { jobs: counts('jobs'), outbox: counts('outbox') };
  }

  /** Manual redrive of a dead job, retaining its delivery ID and resetting the attempt count. */
  retryJob(id: number): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE jobs SET status='queued',attempts=0,next_run_at=?,
      last_error=NULL,updated_at=? WHERE id=? AND status='dead'`)
      .run(now, now, id).changes === 1;
  }

  retryOutbox(id: number): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE outbox SET status='queued',attempts=0,next_run_at=?,
      last_error=NULL,updated_at=? WHERE id=? AND status='dead'`)
      .run(now, now, id).changes === 1;
  }

  private checkLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('Invalid list limit');
  }

  private toOutbox(row: SqlRow): OutboxRecord {
    return { id: Number(row.id), jobId: Number(row.job_id), key: row.effect_key == null ? undefined : String(row.effect_key),
      kind: row.kind as OutboxInput['kind'], payload: JSON.parse(String(row.payload_json)),
      status: row.status as OutboxRecord['status'], attempts: Number(row.attempts),
      nextRunAt: Number(row.next_run_at), leaseToken: row.lease_token as string | null,
      lastError: row.last_error as string | null };
  }

  private toJob(row: SqlRow): QueueJob {
    return {
      id: Number(row.id), deliveryId: String(row.delivery_id), repository: String(row.repository),
      issueNumber: Number(row.issue_number), eventKind: String(row.event_kind),
      payload: JSON.parse(String(row.payload_json)), status: row.status as QueueJob['status'],
      attempts: Number(row.attempts), nextRunAt: Number(row.next_run_at),
      leaseToken: row.lease_token as string | null,
      leaseExpiresAt: row.lease_expires_at as number | null,
      lastError: row.last_error as string | null,
      result: row.result_json == null ? null : JSON.parse(String(row.result_json)),
    };
  }

  claim(): QueueJob | null {
    return this.transaction(() => {
      const now = this.now();
      this.expire('jobs', now);
      const row = this.db.prepare(`SELECT j.id FROM jobs j
        WHERE j.status = 'queued' AND j.next_run_at <= ?
          AND NOT EXISTS (SELECT 1 FROM jobs earlier
            WHERE earlier.repository = j.repository AND earlier.issue_number = j.issue_number
              AND earlier.id < j.id AND earlier.status IN ('queued','running'))
          AND NOT EXISTS (SELECT 1 FROM jobs active
            WHERE active.repository = j.repository AND active.issue_number = j.issue_number
              AND active.status = 'running')
        ORDER BY j.id LIMIT 1`).get(now) as SqlRow | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1,
        lease_token=?, lease_expires_at=?, updated_at=? WHERE id=?`)
        .run(token, now + this.leaseMs, now, row.id as number);
      return this.getJob(Number(row.id));
    });
  }

  heartbeat(id: number, leaseToken: string): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
      .run(now + this.leaseMs, now, id, leaseToken, now).changes === 1;
  }

  complete(id: number, leaseToken: string, effects: OutboxInput[] = [], result?: unknown): boolean {
    return this.transaction(() => {
      const now = this.now();
      const resultJson = result === undefined ? null : JSON.stringify(result);
      if (resultJson === undefined) throw new TypeError('Job result must be JSON serializable');
      const changed = this.db.prepare(`UPDATE jobs SET status='done',lease_token=NULL,
        lease_expires_at=NULL,finished_at=?,updated_at=?,result_json=?
        WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
        .run(now, now, resultJson, id, leaseToken, now).changes;
      if (!changed) return false;
      this.insertEffects(id, effects, now);
      this.db.prepare(`INSERT INTO issue_heads(repository,issue_number,job_id)
        SELECT repository,issue_number,id FROM jobs WHERE id=?
        ON CONFLICT(repository,issue_number) DO UPDATE SET job_id=excluded.job_id`).run(id);
      return true;
    });
  }

  enqueueEffects(jobId: number, leaseToken: string, effects: OutboxInput[]): boolean {
    return this.transaction(() => {
      const now = this.now();
      const owned = this.db.prepare(`SELECT id FROM jobs WHERE id=? AND status='running'
        AND lease_token=? AND lease_expires_at>?`).get(jobId, leaseToken, now);
      if (!owned) return false;
      this.insertEffects(jobId, effects, now);
      return true;
    });
  }

  private insertEffects(jobId: number, effects: OutboxInput[], now: number): void {
    for (const effect of effects) {
      if (effect.kind !== 'comment' && effect.kind !== 'reaction') throw new TypeError('Invalid outbox kind');
      const payload = JSON.stringify(effect.payload);
      if (payload === undefined) throw new TypeError('Outbox payload must be JSON serializable');
      if (effect.key !== undefined && !effect.key) throw new TypeError('Effect key must be nonempty');
      this.db.prepare(`INSERT INTO outbox (job_id,effect_key,kind,payload_json,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(job_id,effect_key) DO NOTHING`)
        .run(jobId, effect.key ?? null, effect.kind, payload, now, now, now);
    }
  }

  fail(id: number, leaseToken: string, error: unknown, effects: OutboxInput[] = []): 'queued' | 'dead' | null {
    return this.failEntry('jobs', id, leaseToken, error, effects);
  }

  claimOutbox(): OutboxEntry | null {
    return this.transaction(() => {
      const now = this.now();
      this.expire('outbox', now);
      const row = this.db.prepare(`SELECT o.* FROM outbox o WHERE o.status='queued'
        AND o.next_run_at<=? AND NOT EXISTS (
          SELECT 1 FROM outbox earlier WHERE earlier.job_id=o.job_id AND earlier.id<o.id
            AND earlier.status IN ('queued','running')) ORDER BY o.id LIMIT 1`).get(now) as SqlRow | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db.prepare(`UPDATE outbox SET status='running',attempts=attempts+1,
        lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?`)
        .run(token, now + this.leaseMs, now, row.id as number);
      return { id: Number(row.id), jobId: Number(row.job_id), key: row.effect_key == null ? undefined : String(row.effect_key),
        kind: row.kind as OutboxInput['kind'],
        payload: JSON.parse(String(row.payload_json)), attempts: Number(row.attempts) + 1,
        leaseToken: token };
    });
  }

  completeOutbox(id: number, leaseToken: string): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE outbox SET status='done',lease_token=NULL,
      lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running'
      AND lease_token=? AND lease_expires_at>?`).run(now, id, leaseToken, now).changes === 1;
  }

  heartbeatOutbox(id: number, leaseToken: string): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE outbox SET lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
      .run(now + this.leaseMs, now, id, leaseToken, now).changes === 1;
  }

  failOutbox(id: number, leaseToken: string, error: unknown): 'queued' | 'dead' | null {
    return this.failEntry('outbox', id, leaseToken, error);
  }

  private failEntry(table: 'jobs' | 'outbox', id: number, token: string, error: unknown,
                    effects: OutboxInput[] = []): 'queued' | 'dead' | null {
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.prepare(`SELECT attempts FROM ${table} WHERE id=? AND status='running'
        AND lease_token=? AND lease_expires_at>?`).get(id, token, now) as SqlRow | undefined;
      if (!row) return null;
      const attempts = Number(row.attempts);
      const status = attempts >= this.maxAttempts ? 'dead' : 'queued';
      this.db.prepare(`UPDATE ${table} SET status=?,next_run_at=?,lease_token=NULL,
        lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?`)
        .run(status, now + this.backoff(attempts), String(error), now, id);
      if (table === 'jobs') this.insertEffects(id, effects, now);
      return status;
    });
  }

  private expire(table: 'jobs' | 'outbox', now: number): void {
    const rows = this.db.prepare(`SELECT id,attempts FROM ${table} WHERE status='running'
      AND lease_expires_at<=?`).all(now) as SqlRow[];
    for (const row of rows) {
      const attempts = Number(row.attempts);
      this.db.prepare(`UPDATE ${table} SET status=?,next_run_at=?,lease_token=NULL,
        lease_expires_at=NULL,last_error='Lease expired',updated_at=? WHERE id=?`)
        .run(attempts >= this.maxAttempts ? 'dead' : 'queued',
          now + this.backoff(attempts), now, row.id as number);
    }
  }
}
