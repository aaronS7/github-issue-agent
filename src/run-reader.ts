import { constants } from 'node:fs';
import { existsSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;
export type RunState = 'queued' | 'running' | 'done' | 'dead';
export type RunCounts = Record<RunState, number>;

export interface RunAttempt {
  id: string;
  attempt: number;
  status: string;
  phase: string;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  steps: number;
  failedCommands: number;
  modelCalls: number;
  modelMs: number;
  commandMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  hasRecording: boolean;
  recordingTruncated: boolean;
  traceTruncated: boolean;
}

export interface RunJob {
  id: number;
  repository: string;
  issueNumber: number;
  title: string;
  eventKind: string;
  status: RunState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  nextRunAt: number;
  leaseExpiresAt: number | null;
  lastError: string | null;
  result: { commit?: string; changed?: boolean; summary?: string } | null;
  latestRun: RunAttempt | null;
  feedback: RunCounts;
}

export interface RunEvent {
  id: number;
  type: string;
  at: number;
  elapsedMs: number;
  data: Record<string, unknown>;
}

export interface RunFeedback {
  id: number;
  kind: string;
  status: RunState;
  attempts: number;
  nextRunAt: number;
  lastError: string | null;
}

export interface RunList {
  available: boolean;
  dataDir: string;
  counts: { jobs: RunCounts; outbox: RunCounts };
  jobs: RunJob[];
  nextCursor: number | null;
}

export interface RunDetail {
  job: RunJob;
  attempts: RunAttempt[];
  run: RunAttempt | null;
  events: RunEvent[];
  nextCursor: number;
  hasMore: boolean;
  feedback: RunFeedback[];
}

export interface Recording {
  bytes: Buffer;
  filename: string;
  partial: boolean;
}

export class InvalidRunReaderInputError extends Error {
  constructor(message = 'Invalid run reader input') {
    super(message);
    this.name = 'InvalidRunReaderInputError';
  }
}

const recordingMaxBytes = 100 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const statuses: readonly RunState[] = ['queued', 'running', 'done', 'dead'];

function countZero(): RunCounts {
  return { queued: 0, running: 0, done: 0, dead: 0 };
}

function positive(value: number | undefined, fallback: number, max: number): number {
  const answer = value ?? fallback;
  if (!Number.isSafeInteger(answer) || answer < 1 || answer > max) {
    throw new InvalidRunReaderInputError('Invalid limit');
  }
  return answer;
}

function cursor(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new InvalidRunReaderInputError(`Invalid ${name}`);
  }
  return value;
}

function timestamp(value: number | undefined): number {
  const answer = value ?? Date.now();
  if (!Number.isSafeInteger(answer) || answer < 0) throw new InvalidRunReaderInputError('Invalid time');
  return answer;
}

function openExisting(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  return new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function counts(db: DatabaseSync, table: 'jobs' | 'outbox'): RunCounts {
  const result = countZero();
  for (const row of db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all() as Row[]) {
    const status = String(row.status) as RunState;
    if (statuses.includes(status)) result[status] = Number(row.count);
  }
  return result;
}

function resultFromJson(value: unknown): RunJob['result'] {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const result: NonNullable<RunJob['result']> = {};
    if (typeof obj.commit === 'string') result.commit = obj.commit;
    if (typeof obj.changed === 'boolean') result.changed = obj.changed;
    if (typeof obj.summary === 'string') result.summary = obj.summary;
    return result;
  } catch { return null; }
}

function titleFromJson(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.title === 'string') return obj.title;
    const issue = obj.issue;
    const issueTitle = issue && typeof issue === 'object' && !Array.isArray(issue)
      ? (issue as Record<string, unknown>).title : undefined;
    return typeof issueTitle === 'string' ? issueTitle : '';
  } catch { return ''; }
}

function feedbackCounts(db: DatabaseSync, jobId: number): RunCounts {
  const result = countZero();
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM outbox WHERE job_id=? GROUP BY status')
    .all(jobId) as Row[]) {
    const status = String(row.status) as RunState;
    if (statuses.includes(status)) result[status] = Number(row.count);
  }
  return result;
}

function attemptFromRow(row: Row, job: Row, now: number): RunAttempt {
  let status = String(row.status);
  if (status === 'running') {
    if (job.status !== 'running' || row.lease_token !== job.lease_token || !job.lease_token) {
      status = 'interrupted';
    } else if (job.lease_expires_at == null || Number(job.lease_expires_at) <= now) {
      status = 'lease-expired';
    }
  }
  return {
    id: String(row.id), attempt: Number(row.attempt), status, phase: String(row.phase),
    startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    summary: row.summary == null ? null : String(row.summary),
    error: row.error == null ? null : String(row.error),
    steps: Number(row.steps), failedCommands: Number(row.failed_commands),
    modelCalls: Number(row.model_calls), modelMs: Number(row.model_ms),
    commandMs: Number(row.command_ms),
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    hasRecording: row.recording_path != null,
    recordingTruncated: Boolean(row.recording_truncated),
    traceTruncated: Boolean(row.trace_truncated),
  };
}

function latestAttempt(db: DatabaseSync | null, row: Row, now: number): RunAttempt | null {
  if (!db || !hasTable(db, 'run_attempts')) return null;
  const attempt = db.prepare(`SELECT * FROM run_attempts
    WHERE job_id=? AND repository=? AND issue_number=?
    ORDER BY attempt DESC, started_at DESC LIMIT 1`)
    .get(Number(row.id), String(row.repository), Number(row.issue_number)) as Row | undefined;
  return attempt ? attemptFromRow(attempt, row, now) : null;
}

function jobFromRow(db: DatabaseSync, obs: DatabaseSync | null, row: Row, now: number): RunJob {
  return {
    id: Number(row.id), repository: String(row.repository), issueNumber: Number(row.issue_number),
    title: titleFromJson(row.payload_json), eventKind: String(row.event_kind),
    status: row.status as RunState, attempts: Number(row.attempts),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    nextRunAt: Number(row.next_run_at),
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    result: resultFromJson(row.result_json), latestRun: latestAttempt(obs, row, now),
    feedback: feedbackCounts(db, Number(row.id)),
  };
}

export async function readRuns(dataDir: string, options: {
  status?: 'all' | RunState; limit?: number; before?: number; now?: number;
} = {}): Promise<RunList> {
  const base = resolve(dataDir);
  const limit = positive(options.limit, 25, 50);
  const before = cursor(options.before, 'before');
  const now = timestamp(options.now);
  const status = options.status ?? 'all';
  if (status !== 'all' && !statuses.includes(status)) throw new InvalidRunReaderInputError('Invalid status');
  const empty: RunList = {
    available: false, dataDir: base, counts: { jobs: countZero(), outbox: countZero() },
    jobs: [], nextCursor: null,
  };
  const queue = openExisting(join(base, 'queue.sqlite'));
  if (!queue) return empty;
  let obs: DatabaseSync | null = null;
  try {
    if (!hasTable(queue, 'jobs') || !hasTable(queue, 'outbox')) return empty;
    obs = openExisting(join(base, 'observability.sqlite'));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (status !== 'all') { where.push('status=?'); params.push(status); }
    if (before !== undefined) { where.push('id<?'); params.push(before); }
    const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = queue.prepare(sql).all(...params, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const shown = rows.slice(0, limit);
    const jobs = shown.map(row => jobFromRow(queue, obs, row, now));
    return {
      available: true, dataDir: base,
      counts: { jobs: counts(queue, 'jobs'), outbox: counts(queue, 'outbox') },
      jobs, nextCursor: hasMore ? jobs.at(-1)!.id : null,
    };
  } finally { obs?.close(); queue.close(); }
}

function feedback(db: DatabaseSync, jobId: number): RunFeedback[] {
  return (db.prepare(`SELECT id,kind,status,attempts,next_run_at,last_error FROM outbox
    WHERE job_id=? ORDER BY id`).all(jobId) as Row[]).map(row => ({
    id: Number(row.id), kind: String(row.kind), status: row.status as RunState,
    attempts: Number(row.attempts), nextRunAt: Number(row.next_run_at),
    lastError: row.last_error == null ? null : String(row.last_error),
  }));
}

export async function readRun(dataDir: string, jobId: number, runId?: string, options: {
  after?: number; limit?: number; now?: number;
} = {}): Promise<RunDetail | null> {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new InvalidRunReaderInputError('Invalid job ID');
  if (runId !== undefined && !uuidPattern.test(runId)) throw new InvalidRunReaderInputError('Invalid run ID');
  const after = cursor(options.after, 'after') ?? 0;
  const limit = positive(options.limit, 200, 500);
  const now = timestamp(options.now);
  const base = resolve(dataDir);
  const queue = openExisting(join(base, 'queue.sqlite'));
  if (!queue) return null;
  let obs: DatabaseSync | null = null;
  try {
    if (!hasTable(queue, 'jobs') || !hasTable(queue, 'outbox')) return null;
    const row = queue.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as Row | undefined;
    if (!row) return null;
    obs = openExisting(join(base, 'observability.sqlite'));
    const attempts = obs && hasTable(obs, 'run_attempts')
      ? (obs.prepare(`SELECT * FROM run_attempts
          WHERE job_id=? AND repository=? AND issue_number=?
          ORDER BY attempt DESC, started_at DESC`)
        .all(jobId, String(row.repository), Number(row.issue_number)) as Row[])
        .map(item => attemptFromRow(item, row, now)) : [];
    const run = runId === undefined ? (attempts[0] ?? null) :
      (attempts.find(item => item.id === runId) ?? null);
    if (runId !== undefined && !run) return null;
    let events: RunEvent[] = [];
    let hasMore = false;
    if (run && obs && hasTable(obs, 'run_events')) {
      const rows = obs.prepare(`SELECT id,type,at,elapsed_ms,data_json FROM run_events
        WHERE run_id=? AND id>? ORDER BY id LIMIT ?`).all(run.id, after, limit + 1) as Row[];
      hasMore = rows.length > limit;
      events = rows.slice(0, limit).map(item => {
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(String(item.data_json));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            data = parsed as Record<string, unknown>;
          }
        } catch { /* A damaged event remains readable without its payload. */ }
        return { id: Number(item.id), type: String(item.type), at: Number(item.at),
          elapsedMs: Number(item.elapsed_ms), data };
      });
    }
    return {
      job: jobFromRow(queue, obs, row, now), attempts, run, events,
      nextCursor: events.at(-1)?.id ?? after, hasMore, feedback: feedback(queue, jobId),
    };
  } finally { obs?.close(); queue.close(); }
}

/** Read a single, complete JSONL snapshot from a recording owned by this job. */
export async function readRecording(dataDir: string, jobId: number, runId: string): Promise<Recording | null> {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new InvalidRunReaderInputError('Invalid job ID');
  if (!uuidPattern.test(runId)) throw new InvalidRunReaderInputError('Invalid run ID');
  const base = resolve(dataDir);
  const queue = openExisting(join(base, 'queue.sqlite'));
  if (!queue) return null;
  let obs: DatabaseSync | null = null;
  try {
    if (!hasTable(queue, 'jobs')) return null;
    const job = queue.prepare('SELECT repository,issue_number FROM jobs WHERE id=?').get(jobId) as Row | undefined;
    if (!job) return null;
    obs = openExisting(join(base, 'observability.sqlite'));
    if (!obs || !hasTable(obs, 'run_attempts')) return null;
    const row = obs.prepare(`SELECT recording_path,recording_truncated,status,finished_at
      FROM run_attempts WHERE id=? AND job_id=? AND repository=? AND issue_number=?`)
      .get(runId, jobId, String(job.repository), Number(job.issue_number)) as Row | undefined;
    if (!row || typeof row.recording_path !== 'string') return null;
    const recordingsDir = join(base, 'recordings');
    const file = join(recordingsDir, `${runId}.cast`);
    if (resolve(row.recording_path) !== file) return null;
    try {
      const directoryInfo = await lstat(recordingsDir);
      const fileInfo = await lstat(file);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
          !fileInfo.isFile() || fileInfo.isSymbolicLink()) return null;
      const rootReal = await realpath(base);
      const directoryReal = await realpath(recordingsDir);
      const fileReal = await realpath(file);
      const fromRoot = relative(rootReal, fileReal);
      if (directoryReal !== join(rootReal, 'recordings') || fileReal !== join(directoryReal, `${runId}.cast`) ||
          fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return null;
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > recordingMaxBytes ||
            info.dev !== fileInfo.dev || info.ino !== fileInfo.ino ||
            await realpath(recordingsDir) !== directoryReal || await realpath(file) !== fileReal) return null;
        const length = Number(info.size);
        const bytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const afterInfo = await handle.stat();
        const lastLine = bytes.subarray(0, offset).lastIndexOf(10);
        const complete = lastLine < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastLine + 1);
        return {
          bytes: complete, filename: `${runId}.cast`,
          partial: Boolean(row.recording_truncated) || complete.length !== length ||
            afterInfo.size !== length ||
            !['succeeded', 'retrying', 'failed'].includes(String(row.status)) || row.finished_at == null,
        };
      } finally { await handle.close(); }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
          ['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES'].includes(String(error.code))) return null;
      throw error;
    }
  } finally { obs?.close(); queue.close(); }
}
