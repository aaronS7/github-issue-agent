import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { defineCommand } from 'just-bash';
import { loadConfig } from '../src/config.js';
import type { IssueEvent } from '../src/events.js';
import { ScriptedModel } from '../src/model.js';
import { DurableQueue } from '../src/queue.js';
import { Worker } from '../src/worker.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
}
async function fixture(maxAttempts = 1) {
  const root = await mkdtemp(join(tmpdir(), 'observer-worker-'));
  const source = join(root, 'source');
  git(root, 'init', '-q', source);
  await writeFile(join(source, 'README.md'), 'Base\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'base');
  const config = loadConfig({ GITHUB_REPOSITORY: 'owner/repo', REPOSITORY_PATH: source,
    GITHUB_WEBHOOK_SECRET: 'webhook-secret', GITHUB_FEEDBACK: 'false', DATA_DIR: join(root, 'data'),
    MAX_ATTEMPTS: String(maxAttempts), MAX_STEPS: '5', RUN_TIMEOUT_MS: '30000', LEASE_MS: '3000',
    ASCIINEMA_ENABLED: 'true' });
  const queue = new DurableQueue(config.database, { leaseMs: config.leaseMs, maxAttempts, baseBackoffMs: 0 });
  const issue: IssueEvent = { repository: 'owner/repo', issueNumber: 9, title: 'Do it', body: 'Make a note',
    author: 'alice', labels: [], action: 'opened', kind: 'issue', url: 'https://github.com/owner/repo/issues/9' };
  const jobId = queue.enqueue({ deliveryId: 'd1', repository: issue.repository, issueNumber: issue.issueNumber,
    eventKind: 'issues.opened', payload: issue });
  const close = async () => { queue.close(); await rm(root, { recursive: true, force: true }); };
  return { root, source, config, queue, jobId, close };
}

test('worker records command, model and capability lifecycle without changing queue outcome', async () => {
  const f = await fixture();
  const logs: Record<string, unknown>[] = [];
  const worker = new Worker({ queue: f.queue, config: f.config, log: (event) => logs.push(event),
    extensions: { capabilities: [{ name: 'hello', description: 'Print hello',
      create: () => defineCommand('hello', async () => ({ stdout: 'hello\n', stderr: '', exitCode: 0 })) }] },
    createModel: () => new ScriptedModel([
      { script: 'hello', usage: { inputTokens: 4, outputTokens: 2 } },
      { script: 'cat README.md' },
      { script: "printf 'done\\n' > result.txt" },
      { text: 'Added result.txt.' },
    ]) });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(f.queue.getJob(f.jobId)?.status, 'done');
    const db = new DatabaseSync(join(f.config.dataDir, 'observability.sqlite'), { readOnly: true });
    try {
      const attempt = db.prepare('SELECT * FROM run_attempts WHERE job_id=?').get(f.jobId) as Record<string, unknown>;
      assert.equal(attempt.status, 'succeeded');
      assert.equal(attempt.steps, 3);
      assert.equal(attempt.model_calls, 4);
      assert.equal(attempt.input_tokens, 4);
      const types = (db.prepare('SELECT type FROM run_events WHERE run_id=? ORDER BY id').all(attempt.id as string) as { type: string }[])
        .map((row) => row.type);
      assert.ok(types.includes('model-start'));
      assert.ok(types.includes('model-end'));
      assert.ok(types.includes('command-start'));
      assert.ok(types.includes('command'));
      assert.ok(types.includes('capability-start'));
      assert.ok(types.includes('capability-end'));
      assert.ok(types.includes('run-end'));
      assert.ok((await readFile(attempt.recording_path as string, 'utf8')).includes('Added result.txt.'));
      assert.equal(logs.some((event) => 'script' in event || 'stdout' in event), false);
      assert.ok(logs.some((event) => event.event === 'succeeded' &&
        event.runId === attempt.id && event.attempt === 1));
    } finally { db.close(); }
  } finally { await worker.stop(); await f.close(); }
});

test('source failure creates separate retry and failure attempts before any workspace exists', async () => {
  const f = await fixture(2);
  const logs: Record<string, unknown>[] = [];
  const worker = new Worker({ queue: f.queue, config: f.config, log: (event) => logs.push(event),
    resolveSource: async () => { throw new Error('source unavailable webhook-secret'); },
    createModel: () => new ScriptedModel([{ text: 'unused' }]) });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(f.queue.getJob(f.jobId)?.status, 'queued');
    assert.equal(await worker.processNext(), true);
    assert.equal(f.queue.getJob(f.jobId)?.status, 'dead');
    const db = new DatabaseSync(join(f.config.dataDir, 'observability.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT id,attempt,status,phase,error FROM run_attempts ORDER BY attempt').all() as Record<string, unknown>[];
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]?.id, rows[1]?.id);
      assert.deepEqual(rows.map((row) => row.status), ['retrying', 'failed']);
      assert.deepEqual(rows.map((row) => row.phase), ['finished', 'finished']);
      assert.ok(rows.every((row) => row.error === 'source unavailable [REDACTED]'));
      assert.doesNotMatch(JSON.stringify(logs), /webhook-secret/);
      assert.deepEqual(logs.filter((event) => event.event === 'run-error').map((event) =>
        [event.runId, event.attempt]), rows.map((row) => [row.id, row.attempt]));
    } finally { db.close(); }
  } finally { await worker.stop(); await f.close(); }
});

test('recorder I/O failure does not retry a completed issue', async () => {
  const f = await fixture();
  await mkdir(f.config.dataDir, { recursive: true });
  await writeFile(join(f.config.dataDir, 'recordings'), 'block directory creation');
  const logs: Record<string, unknown>[] = [];
  const worker = new Worker({ queue: f.queue, config: f.config, log: (event) => logs.push(event),
    createModel: () => new ScriptedModel([{ script: "printf 'done\\n' > result.txt" }, { text: 'Done.' }]) });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(f.queue.getJob(f.jobId)?.status, 'done');
    assert.equal(logs.filter((entry) => entry.event === 'observability-error').length, 1);
    const db = new DatabaseSync(join(f.config.dataDir, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT status,recording_path FROM run_attempts').get() as Record<string, unknown>;
      assert.equal(row.status, 'succeeded');
      assert.equal(row.recording_path, null);
    } finally { db.close(); }
  } finally { await worker.stop(); await f.close(); }
});

test('stop waits for a manually started run and closes its observation handles', async () => {
  const f = await fixture();
  let started!: () => void;
  const reachedCommand = new Promise<void>((resolve) => { started = resolve; });
  const logs: Record<string, unknown>[] = [];
  const worker = new Worker({ queue: f.queue, config: f.config, log: (event) => logs.push(event),
    extensions: { capabilities: [{ name: 'slow', description: 'Wait for cancellation',
      create: ({ signal }) => defineCommand('slow', async () => {
        started();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { stdout: '', stderr: '', exitCode: 0 };
      }) }] },
    createModel: () => new ScriptedModel([{ script: 'slow' }]) });
  try {
    const run = worker.processNext();
    await reachedCommand;
    await worker.stop();
    assert.equal(await run, true);
    const db = new DatabaseSync(join(f.config.dataDir, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT status,phase FROM run_attempts').get() as Record<string, unknown>;
      assert.equal(row.status, 'failed');
      assert.equal(row.phase, 'finished');
      assert.ok(db.prepare("SELECT id FROM run_events WHERE type='command-error'").get());
      assert.ok(logs.some((event) => event.event === 'command-error' && event.runId && event.attempt === 1));
    } finally { db.close(); }
  } finally { await worker.stop(); await f.close(); }
});
