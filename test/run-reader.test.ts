import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DurableQueue } from '../src/queue.js';
import { readRecording, readRun, readRuns } from '../src/run-reader.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-runs-'));
  const queue = new DurableQueue(join(dir, 'queue.sqlite'), { now: () => 1000, leaseMs: 100 });
  const obs = new DatabaseSync(join(dir, 'observability.sqlite'));
  obs.exec(`CREATE TABLE run_attempts (
    id TEXT PRIMARY KEY, job_id INTEGER, attempt INTEGER, repository TEXT, issue_number INTEGER,
    lease_token TEXT, status TEXT, phase TEXT, started_at INTEGER, updated_at INTEGER,
    finished_at INTEGER, summary TEXT, error TEXT, steps INTEGER, failed_commands INTEGER,
    model_calls INTEGER, model_ms REAL, command_ms REAL, input_tokens INTEGER,
    output_tokens INTEGER, recording_path TEXT, recording_truncated INTEGER, trace_truncated INTEGER
  );
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, type TEXT, at INTEGER,
    elapsed_ms REAL, data_json TEXT
  );`);
  const enqueue = (deliveryId: string, title = deliveryId) => queue.enqueue({
    deliveryId, repository: 'owner/repo', issueNumber: 7, eventKind: 'issues.opened',
    payload: { issue: { title, body: 'private issue body' }, token: 'secret-token' },
  });
  const attempt = (jobId: number, leaseToken: string, options: {
    id?: string; status?: string; recordingPath?: string; attempt?: number;
  } = {}) => {
    const id = options.id ?? randomUUID();
    obs.prepare(`INSERT INTO run_attempts VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, jobId, options.attempt ?? 1, 'owner/repo', 7, leaseToken,
      options.status ?? 'running', 'agent', 1000, 1001, null, null, null,
      2, 0, 1, 12.5, 3.5, 100, 20, options.recordingPath ?? null, 0, 0,
    );
    return id;
  };
  return { dir, queue, obs, enqueue, attempt, cleanup: () => {
    obs.close(); queue.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('missing data does not create queue or observability files', async () => {
  const dir = join(tmpdir(), `issue-runs-missing-${randomUUID()}`);
  assert.deepEqual(await readRuns(dir), {
    available: false, dataDir: dir,
    counts: { jobs: { queued: 0, running: 0, done: 0, dead: 0 },
      outbox: { queued: 0, running: 0, done: 0, dead: 0 } },
    jobs: [], nextCursor: null,
  });
  assert.equal(existsSync(dir), false);
});

test('an existing queue remains readable when no observability database exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-runs-queue-only-'));
  try {
    const queue = new DurableQueue(join(dir, 'queue.sqlite'));
    const id = queue.enqueue({ deliveryId: 'queue-only', repository: 'owner/repo',
      issueNumber: 1, eventKind: 'issues.opened', payload: { title: 'Queue only' } });
    queue.close();
    const list = await readRuns(dir);
    assert.equal(list.available, true);
    assert.equal(list.jobs[0]?.id, id);
    assert.equal(list.jobs[0]?.latestRun, null);
    assert.equal((await readRun(dir, id))?.run, null);
    assert.equal(existsSync(join(dir, 'observability.sqlite')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list uses queue result, filters and paginates without exposing private fields', async () => {
  const f = fixture();
  try {
    const first = f.enqueue('first', 'First');
    const second = f.enqueue('second', 'Second');
    const third = f.enqueue('third', 'Third');
    const claimed = f.queue.claim()!;
    assert.equal(claimed.id, first);
    const id = f.attempt(first, claimed.leaseToken!);
    assert.equal(f.queue.complete(first, claimed.leaseToken!, [{ kind: 'comment', payload: { body: 'private feedback' } }],
      { commit: 'abc123', changed: true, summary: 'Done', patchPath: '/private/patch' }), true);
    const bytesBefore = readFileSync(join(f.dir, 'queue.sqlite'));
    const list = await readRuns(f.dir, { limit: 2, now: 1001 });
    assert.equal(list.available, true);
    assert.deepEqual(list.jobs.map(job => job.id), [third, second]);
    assert.equal(list.nextCursor, second);
    assert.deepEqual(list.counts.jobs, { queued: 2, running: 0, done: 1, dead: 0 });
    assert.deepEqual(list.counts.outbox, { queued: 1, running: 0, done: 0, dead: 0 });
    const page = await readRuns(f.dir, { before: list.nextCursor!, limit: 2, status: 'done', now: 1001 });
    assert.equal(page.nextCursor, null);
    assert.equal(page.jobs[0]?.id, first);
    assert.equal(page.jobs[0]?.title, 'First');
    assert.deepEqual(page.jobs[0]?.result, { commit: 'abc123', changed: true, summary: 'Done' });
    assert.deepEqual(page.jobs[0]?.feedback, { queued: 1, running: 0, done: 0, dead: 0 });
    assert.equal(page.jobs[0]?.latestRun?.id, id);
    assert.equal(page.jobs[0]?.latestRun?.status, 'interrupted');
    const serialized = JSON.stringify(page);
    assert.doesNotMatch(serialized, /secret-token|private issue body|private feedback|patchPath|leaseToken|recordingPath/);
    assert.deepEqual(readFileSync(join(f.dir, 'queue.sqlite')), bytesBefore);
  } finally { f.cleanup(); }
});

test('detail selects only attempts owned by job and pages events by ID', async () => {
  const f = fixture();
  try {
    const one = f.enqueue('one');
    const two = f.enqueue('two');
    const claimed = f.queue.claim()!;
    const oneRun = f.attempt(one, claimed.leaseToken!);
    const otherRun = f.attempt(two, 'other-token');
    const mismatched = f.attempt(one, claimed.leaseToken!, { attempt: 2 });
    f.obs.prepare("UPDATE run_attempts SET repository='different/repo' WHERE id=?").run(mismatched);
    for (let n = 1; n <= 3; n++) {
      f.obs.prepare('INSERT INTO run_events (run_id,type,at,elapsed_ms,data_json) VALUES (?,?,?,?,?)')
        .run(oneRun, 'command', 1000 + n, n * 10, JSON.stringify({ command: `step ${n}` }));
    }
    const first = await readRun(f.dir, one, oneRun, { limit: 2, now: 1001 });
    assert.equal(first?.job.id, one);
    assert.equal(first?.run?.status, 'running');
    assert.deepEqual(first?.attempts.map(attempt => attempt.id), [oneRun]);
    assert.deepEqual(first?.events.map(event => event.id), [1, 2]);
    assert.equal(first?.hasMore, true);
    assert.equal(first?.nextCursor, 2);
    const second = await readRun(f.dir, one, oneRun, { after: first!.nextCursor, limit: 2, now: 1001 });
    assert.deepEqual(second?.events.map(event => event.id), [3]);
    assert.equal(second?.hasMore, false);
    assert.equal(await readRun(f.dir, one, otherRun), null);
    assert.equal(await readRun(f.dir, 9999), null);
    assert.equal((await readRun(f.dir, one, oneRun, { now: 1100 }))?.run?.status, 'lease-expired');
  } finally { f.cleanup(); }
});

test('recording requires job ownership, canonical path and a regular file', async () => {
  const f = fixture();
  try {
    const one = f.enqueue('one');
    const two = f.enqueue('two');
    const claimed = f.queue.claim()!;
    const runId = randomUUID();
    const recordingDir = join(f.dir, 'recordings');
    mkdirSync(recordingDir);
    const file = join(recordingDir, `${runId}.cast`);
    f.attempt(one, claimed.leaseToken!, { id: runId, recordingPath: file });
    writeFileSync(file, '{"version":2}\n[0.1,"o","hello"]\n[0.2,"o","unfinished"');
    const recording = await readRecording(f.dir, one, runId);
    assert.equal(recording?.filename, `${runId}.cast`);
    assert.equal(recording?.bytes.toString(), '{"version":2}\n[0.1,"o","hello"]\n');
    assert.equal(recording?.partial, true);
    assert.equal(await readRecording(f.dir, two, runId), null);
    rmSync(file);
    writeFileSync(file, '{"version":2}\n');
    assert.equal((await readRecording(f.dir, one, runId))?.partial, true);
    f.obs.prepare("UPDATE run_attempts SET status='succeeded',finished_at=1100 WHERE id=?").run(runId);
    assert.equal((await readRecording(f.dir, one, runId))?.partial, false);
    f.obs.prepare("UPDATE run_attempts SET repository='different/repo' WHERE id=?").run(runId);
    assert.equal(await readRecording(f.dir, one, runId), null);
    f.obs.prepare("UPDATE run_attempts SET repository='owner/repo' WHERE id=?").run(runId);
    rmSync(file);
    const outside = join(f.dir, 'outside.cast');
    writeFileSync(outside, 'private\n');
    symlinkSync(outside, file);
    assert.equal(await readRecording(f.dir, one, runId), null);
    rmSync(file);
    writeFileSync(file, '{"version":2}\n');
    f.obs.prepare('UPDATE run_attempts SET recording_path=? WHERE id=?').run(outside, runId);
    assert.equal(await readRecording(f.dir, one, runId), null);
  } finally { f.cleanup(); }
});
