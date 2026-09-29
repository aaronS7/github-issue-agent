import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentTraceEvent } from './agent.js';
import type { ObservabilityConfig } from './config.js';
import type { QueueJob } from './queue.js';

export type RunStatus = 'running' | 'succeeded' | 'retrying' | 'failed' | 'interrupted';
export type RunPhase = 'preparing' | 'model' | 'command' | 'finalizing' | 'finished';
const MAX_EVENT_BYTES = 16_384;
const MAX_TRACE_BYTES = 10_485_760;
const MAX_EVENTS = 10_000;

/** Remove terminal escape/control sequences before displaying untrusted scripts and output. */
export function safeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\[[^\x1b]*|\([^\x1b]?|\)[^\x1b]?|[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function secretValues(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => b.length - a.length);
}

function cleanText(value: string, secrets: readonly string[]): string {
  let result = safeTerminalText(value);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
}

function cleanValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return cleanText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => cleanValue(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cleanValue(entry, secrets)]));
  }
  return value;
}

export function redactObservationValue(value: unknown, values: readonly (string | undefined)[]): unknown {
  return cleanValue(value, secretValues([...values, process.env.MODEL_API_KEY,
    process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN, process.env.GITHUB_WEBHOOK_SECRET]));
}

function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= MAX_EVENT_BYTES) return encoded;
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : { type: 'event', value };
  const bounded: Record<string, unknown> = { ...source, truncated: true };
  const clipped: string[] = [];
  const limitString = (text: string, maxBytes: number): string => {
    if (Buffer.byteLength(JSON.stringify(text)) <= maxBytes) return text;
    const chars = Array.from(text);
    const suffix = '… [truncated]';
    let low = 0, high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = chars.slice(0, middle).join('') + suffix;
      if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    return chars.slice(0, low).join('') + suffix;
  };
  for (const [key, entry] of Object.entries(bounded)) {
    if (typeof entry !== 'string') continue;
    const cap = key === 'summary' ? 8_192 :
      key === 'script' || key === 'stdout' || key === 'stderr' || key === 'error' ? 4_096 : 1_024;
    const shortened = limitString(entry, cap);
    if (shortened !== entry) { bounded[key] = shortened; clipped.push(key); }
  }
  bounded.truncatedFields = clipped;
  let result = JSON.stringify(bounded);
  while (Buffer.byteLength(result) > MAX_EVENT_BYTES) {
    const strings = Object.entries(bounded).filter(([, entry]) => typeof entry === 'string') as [string, string][];
    strings.sort((a, b) => Buffer.byteLength(JSON.stringify(b[1])) - Buffer.byteLength(JSON.stringify(a[1])));
    const largest = strings[0];
    if (!largest || Buffer.byteLength(JSON.stringify(largest[1])) <= 256) break;
    bounded[largest[0]] = limitString(largest[1], Math.floor(Buffer.byteLength(JSON.stringify(largest[1])) / 2));
    if (!clipped.includes(largest[0])) clipped.push(largest[0]);
    result = JSON.stringify(bounded);
  }
  if (Buffer.byteLength(result) <= MAX_EVENT_BYTES) return result;
  return JSON.stringify({ type: typeof source.type === 'string' ? limitString(source.type, 128) : 'event',
    truncated: true, truncatedFields: clipped });
}

export interface RunObserverOptions {
  dataDir: string;
  job: QueueJob;
  recording?: ObservabilityConfig;
  redactValues?: readonly (string | undefined)[];
  onError?: (error: unknown) => void;
}

/** Independent, best-effort run ledger. The queue remains the authority for job state. */
export class RunObserver {
  readonly id = randomUUID();
  recordingPath: string | null = null;
  private readonly startedAt = Date.now();
  private readonly startedMono = performance.now();
  private readonly secrets: string[];
  private readonly maxCastBytes: number;
  private db: DatabaseSync | null = null;
  private castFd: number | null = null;
  private castPath: string | null = null;
  private castBytes = 0;
  private lastCastTime = 0;
  private castTruncated = false;
  private traceTruncated = false;
  private traceBytes = 0;
  private eventCount = 0;
  private errorReported = false;
  private closed = false;
  private stats = { steps: 0, failedCommands: 0, modelCalls: 0, modelMs: 0, commandMs: 0,
    inputTokens: null as number | null, outputTokens: null as number | null };

  constructor(private readonly options: RunObserverOptions) {
    this.secrets = secretValues([...(options.redactValues ?? []), process.env.MODEL_API_KEY,
      process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN, process.env.GITHUB_WEBHOOK_SECRET]);
    const recording = options.recording;
    this.maxCastBytes = recording?.maxBytes ?? 10_485_760;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(options.dataDir, 'observability.sqlite');
    this.db = new DatabaseSync(dbPath, { timeout: 5_000 });
    try {
      chmodSync(dbPath, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > 1) throw new Error(`Observability schema version ${version} is newer than this program`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS run_attempts (
        id TEXT PRIMARY KEY, job_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
        repository TEXT NOT NULL, issue_number INTEGER NOT NULL, lease_token TEXT NOT NULL,
        status TEXT NOT NULL, phase TEXT NOT NULL, started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, finished_at INTEGER, summary TEXT, error TEXT,
        steps INTEGER NOT NULL DEFAULT 0, failed_commands INTEGER NOT NULL DEFAULT 0,
        model_calls INTEGER NOT NULL DEFAULT 0, model_ms REAL NOT NULL DEFAULT 0,
        command_ms REAL NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER,
        recording_path TEXT, recording_truncated INTEGER NOT NULL DEFAULT 0,
        trace_truncated INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS run_attempts_job ON run_attempts(job_id,attempt);
        CREATE INDEX IF NOT EXISTS run_attempts_started ON run_attempts(started_at DESC);
        CREATE TABLE IF NOT EXISTS run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL,
          at INTEGER NOT NULL, elapsed_ms REAL NOT NULL, data_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id,id);
        PRAGMA user_version=1;`);
      this.db.prepare(`INSERT INTO run_attempts (id,job_id,attempt,repository,issue_number,lease_token,
        status,phase,started_at,updated_at) VALUES (?,?,?,?,?,?,'running','preparing',?,?)`)
        .run(this.id, options.job.id, options.job.attempts, options.job.repository,
          options.job.issueNumber, options.job.leaseToken, this.startedAt, this.startedAt);
    } catch (error) { this.db.close(); this.db = null; throw error; }

    let castPath: string | null = null;
    if (recording?.asciinema) {
      try {
        const dir = join(options.dataDir, 'recordings');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const dirStat = lstatSync(dir);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Invalid recordings directory');
        const fd = openSync(dir, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        castPath = join(dir, `${this.id}.cast`);
        this.castPath = castPath;
        this.castFd = openSync(castPath, 'wx', 0o600);
        const header = JSON.stringify({ version: 2, width: recording.cols, height: recording.rows,
          timestamp: Math.floor(this.startedAt / 1000), title: `Issue #${options.job.issueNumber} attempt ${options.job.attempts}`,
          idle_time_limit: 2 }) + '\n';
        this.writeCastLine(header);
        const createdDir = openSync(dir, 'r');
        try { fsyncSync(createdDir); } finally { closeSync(createdDir); }
        this.db?.prepare('UPDATE run_attempts SET recording_path=? WHERE id=?').run(castPath, this.id);
      } catch (error) {
        this.disableCast(error);
        castPath = null;
      }
    }
    this.recordingPath = castPath;
    this.phase('preparing');
  }

  private report(error: unknown): void {
    if (!this.errorReported) {
      this.errorReported = true;
      try { this.options.onError?.(error); } catch { /* A logging callback cannot affect the run. */ }
    }
  }
  private disableDb(error: unknown): void {
    try { this.db?.close(); } catch { /* Keep queue processing. */ }
    this.db = null;
    this.report(error);
  }
  private disableCast(error: unknown): void {
    try { if (this.castFd !== null) closeSync(this.castFd); } catch { /* Keep queue processing. */ }
    this.castFd = null;
    this.castTruncated ||= this.castBytes > 0;
    this.recordingPath = null;
    this.report(error);
    try { this.db?.prepare('UPDATE run_attempts SET recording_path=NULL,recording_truncated=? WHERE id=?')
      .run(Number(this.castTruncated), this.id); }
    catch (dbError) {
      this.disableDb(dbError);
      // A stale DB path must not serve a partially written file as a complete recording.
      if (this.castPath) try { renameSync(this.castPath, `${this.castPath}.partial`); }
      catch { /* The database and recorder have already been disabled. */ }
    }
  }
  private writeCastLine(line: string): void {
    if (this.castFd === null) return;
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.castFd, bytes, offset, bytes.length - offset);
    fsyncSync(this.castFd);
    this.castBytes += bytes.length;
  }
  private castEvent(kind: 'o' | 'm', text: string, reserve = 512): void {
    if (this.castFd === null || this.castTruncated) return;
    const at = Math.max(this.lastCastTime, (performance.now() - this.startedMono) / 1000);
    const sanitized = cleanText(text, this.secrets);
    const line = JSON.stringify([at, kind, kind === 'o' ? sanitized.replace(/\n/g, '\r\n') : sanitized]) + '\n';
    if (this.castBytes + Buffer.byteLength(line) > this.maxCastBytes - reserve) {
      this.castTruncated = true;
      try {
        this.db?.prepare('UPDATE run_attempts SET recording_truncated=1 WHERE id=?').run(this.id);
        this.writeCastLine(JSON.stringify([at, 'm', 'Recording truncated at configured size limit']) + '\n');
      } catch (error) { this.disableCast(error); }
      return;
    }
    try { this.writeCastLine(line); this.lastCastTime = at; }
    catch (error) { this.disableCast(error); }
  }

  private sync(phase?: RunPhase, status: RunStatus = 'running', summary?: string, error?: string): void {
    if (this.db === null) return;
    try {
      const now = Date.now();
      this.db.prepare(`UPDATE run_attempts SET status=?,phase=COALESCE(?,phase),updated_at=?,
        finished_at=CASE WHEN ?='running' THEN NULL ELSE ? END,
        summary=COALESCE(?,summary),error=COALESCE(?,error),steps=?,failed_commands=?,
        model_calls=?,model_ms=?,command_ms=?,input_tokens=?,output_tokens=?,
        recording_truncated=?,trace_truncated=? WHERE id=?`).run(
        status, phase ?? null, now, status, now,
        summary === undefined ? null : cleanText(summary, this.secrets).slice(0, 16_000),
        error === undefined ? null : cleanText(error, this.secrets).slice(0, 8_000),
        this.stats.steps, this.stats.failedCommands, this.stats.modelCalls,
        this.stats.modelMs, this.stats.commandMs, this.stats.inputTokens, this.stats.outputTokens,
        Number(this.castTruncated), Number(this.traceTruncated), this.id);
    } catch (failure) { this.disableDb(failure); }
  }

  private event(type: string, data: unknown): void {
    if (this.closed || this.db === null) return;
    const json = boundedJson(cleanValue(data, this.secrets));
    const bytes = Buffer.byteLength(json);
    if (this.eventCount >= MAX_EVENTS || this.traceBytes + bytes > MAX_TRACE_BYTES) {
      this.traceTruncated = true;
      this.sync();
      return;
    }
    try {
      this.db.prepare('INSERT INTO run_events (run_id,type,at,elapsed_ms,data_json) VALUES (?,?,?,?,?)')
        .run(this.id, type, Date.now(), Math.max(0, performance.now() - this.startedMono), json);
      this.eventCount++;
      this.traceBytes += bytes;
    } catch (error) { this.disableDb(error); }
  }

  phase(phase: RunPhase): void {
    if (this.closed) return;
    this.event('phase', { type: 'phase', phase });
    this.sync(phase);
    this.castEvent('m', phase);
  }

  trace(entry: AgentTraceEvent): void {
    if (this.closed) return;
    this.event(entry.type, entry);
    switch (entry.type) {
      case 'model-start': this.stats.modelCalls++; this.phase('model'); break;
      case 'model-end':
        this.stats.modelMs += entry.durationMs;
        if (entry.usage?.inputTokens !== undefined) this.stats.inputTokens = (this.stats.inputTokens ?? 0) + entry.usage.inputTokens;
        if (entry.usage?.outputTokens !== undefined) this.stats.outputTokens = (this.stats.outputTokens ?? 0) + entry.usage.outputTokens;
        this.castEvent('m', `model call ${entry.call}: ${entry.outcome} (${Math.round(entry.durationMs)} ms)`);
        break;
      case 'command-start':
        this.phase('command');
        this.castEvent('o', `$ ${entry.script}\n`);
        break;
      case 'command':
        this.stats.steps = Math.max(this.stats.steps, entry.step);
        if (entry.exitCode !== 0) this.stats.failedCommands++;
        this.stats.commandMs += entry.durationMs ?? 0;
        if (entry.stdout) this.castEvent('o', entry.stdout);
        if (entry.stderr) this.castEvent('o', `[stderr] ${entry.stderr}`);
        this.castEvent('m', `exit ${entry.exitCode} (${Math.round(entry.durationMs ?? 0)} ms)`);
        break;
      case 'command-error':
        this.stats.steps = Math.max(this.stats.steps, entry.step);
        this.stats.failedCommands++;
        this.stats.commandMs += entry.durationMs;
        this.castEvent('m', `command error: ${entry.error} (${Math.round(entry.durationMs)} ms)`);
        break;
      case 'capability-start': this.castEvent('m', `capability ${entry.name} started`); break;
      case 'capability-end': this.castEvent('m', `capability ${entry.name} finished (${Math.round(entry.durationMs)} ms)`); break;
      case 'final': this.castEvent('o', `\n${entry.summary}\n`); break;
    }
    this.sync();
  }

  finish(status: Exclude<RunStatus, 'running'>, details: { summary?: string; error?: string } = {}): void {
    if (this.closed) return;
    this.phase('finished');
    this.event('run-end', { type: 'run-end', status, ...details });
    this.sync('finished', status, details.summary, details.error);
    this.castEvent('m', `run ${status}`);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { if (this.castFd !== null) closeSync(this.castFd); } catch (error) { this.report(error); }
    this.castFd = null;
    try { this.db?.close(); } catch (error) { this.report(error); }
    this.db = null;
  }
}
