export type JobStatus = 'queued' | 'running' | 'done' | 'dead';
export type Counts = Record<JobStatus, number>;
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
  traceTruncated?: boolean;
}
export interface RunJob {
  id: number;
  repository: string;
  issueNumber: number;
  title: string;
  eventKind: string;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  nextRunAt: number;
  leaseExpiresAt: number | null;
  lastError: string | null;
  result: { commit?: string; changed?: boolean; summary?: string } | null;
  latestRun: RunAttempt | null;
  feedback: Counts;
}
export interface RunList {
  available: boolean;
  dataDir: string;
  counts: { jobs: Counts; outbox: Counts };
  jobs: RunJob[];
  nextCursor: number | null;
}
export interface RunEvent {
  id: number;
  type: string;
  at: number;
  elapsedMs: number;
  data: Record<string, unknown>;
}
export interface RunDetail {
  job: RunJob;
  attempts: RunAttempt[];
  run: RunAttempt | null;
  events: RunEvent[];
  nextCursor: number;
  hasMore: boolean;
  feedback: { id: number; kind: string; status: JobStatus; attempts: number; nextRunAt: number; lastError: string | null }[];
}
export function runLink(jobId?: number, runId?: string) {
  return `#runs${jobId ? `?job=${jobId}${runId ? `&run=${encodeURIComponent(runId)}` : ''}` : ''}`;
}
export function selectedRun() {
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const id = Number(query.get('job'));
  return { jobId: Number.isSafeInteger(id) && id > 0 ? id : undefined, runId: query.get('run') || undefined };
}
export function duration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
}
export function dateTime(time: number | null) { return time === null ? '—' : new Date(time).toLocaleString(); }
export function statusLabel(status: string) {
  return ({ done: 'Completed', dead: 'Failed', queued: 'Queued', running: 'Running', succeeded: 'Succeeded',
    retrying: 'Retry scheduled', failed: 'Failed', interrupted: 'Interrupted', 'lease-expired': 'Lease expired' } as Record<string, string>)[status] || status;
}
export async function fetchRuns<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    let message = 'Unable to read run history.';
    try { message = (await response.json()).error || message; } catch { /* Generic message for non-JSON responses. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
