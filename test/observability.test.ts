import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { defineCommand } from 'just-bash';
import { runAgent, type AgentTraceEvent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { ScriptedModel } from '../src/model.js';
import { RunObserver } from '../src/observability.js';
import type { QueueJob } from '../src/queue.js';

function job(): QueueJob {
  return { id: 7, status: 'running', attempts: 2, repository: 'owner/repo', issueNumber: 4,
    deliveryId: 'delivery', eventKind: 'issues.opened', payload: {}, nextRunAt: 0,
    leaseToken: 'lease', leaseExpiresAt: Date.now() + 1000, lastError: null, result: null };
}
const recording = { asciinema: true, cols: 100, rows: 28, maxBytes: 65_536 };

test('asciinema settings default off and validate dimensions and byte limit', () => {
  const base = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_WEBHOOK_SECRET: 'secret', GITHUB_FEEDBACK: 'false' };
  assert.deepEqual(loadConfig(base).observability,
    { asciinema: false, cols: 100, rows: 28, maxBytes: 10_485_760 });
  assert.deepEqual(loadConfig({ ...base, ASCIINEMA_ENABLED: 'true', ASCIINEMA_COLS: '120',
    ASCIINEMA_ROWS: '40', ASCIINEMA_MAX_BYTES: '65536' }).observability,
  { asciinema: true, cols: 120, rows: 40, maxBytes: 65_536 });
  assert.throws(() => loadConfig({ ...base, ASCIINEMA_COLS: '39' }), /ASCIINEMA_COLS/);
  assert.throws(() => loadConfig({ ...base, ASCIINEMA_ROWS: '101' }), /ASCIINEMA_ROWS/);
  assert.throws(() => loadConfig({ ...base, ASCIINEMA_MAX_BYTES: '100' }), /ASCIINEMA_MAX_BYTES/);
});

test('durable attempt and asciicast preserve timing and redact terminal content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-observer-'));
  try {
    const observer = new RunObserver({ dataDir: root, job: job(), recording,
      redactValues: ['my-secret-token'] });
    observer.trace({ type: 'model-start', call: 1 });
    observer.trace({ type: 'model-end', call: 1, durationMs: 12.5, outcome: 'scripts',
      usage: { inputTokens: 11, outputTokens: 3 } });
    observer.trace({ type: 'command-start', step: 1,
      script: 'printf my-secret-token; printf "\\033]8;;https://bad.example\\a"' });
    observer.trace({ type: 'command', step: 1, script: 'printf my-secret-token',
      stdout: 'my-secret-token\x1b]0;malicious\x07\n', stderr: '', exitCode: 1, durationMs: 4 });
    observer.trace({ type: 'final', steps: 1, summary: 'Finished my-secret-token' });
    observer.finish('succeeded', { summary: 'Finished my-secret-token' });
    assert.ok(observer.recordingPath);
    assert.equal(existsSync(observer.recordingPath), true);
    const lines = (await readFile(observer.recordingPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual({ version: lines[0].version, width: lines[0].width, height: lines[0].height },
      { version: 2, width: 100, height: 28 });
    assert.ok(lines.slice(1).every((entry) => Array.isArray(entry) && entry.length === 3));
    assert.ok(lines.slice(1).every((entry, index) => index === 0 || entry[0] >= lines[index][0]));
    const outputChunks = lines.slice(1).filter((entry) => entry[1] === 'o').map((entry) => entry[2] as string);
    assert.ok(outputChunks.some((chunk) => chunk.includes('\r\n')));
    assert.ok(outputChunks.every((chunk) => !/(?<!\r)\n/.test(chunk)));
    const cast = await readFile(observer.recordingPath, 'utf8');
    assert.doesNotMatch(cast, /my-secret-token|malicious|\x1b/);
    assert.match(cast, /\[REDACTED\]/);
    const db = new DatabaseSync(join(root, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT * FROM run_attempts WHERE id=?').get(observer.id) as Record<string, unknown>;
      assert.equal(row.status, 'succeeded');
      assert.equal(row.phase, 'finished');
      assert.equal(row.attempt, 2);
      assert.equal(row.steps, 1);
      assert.equal(row.failed_commands, 1);
      assert.equal(row.model_calls, 1);
      assert.equal(row.model_ms, 12.5);
      assert.equal(row.command_ms, 4);
      assert.equal(row.input_tokens, 11);
      assert.equal(row.output_tokens, 3);
      assert.equal(row.recording_path, observer.recordingPath);
      assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM run_events').all()), /my-secret-token|malicious|\x1b/);
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('large escaped and unicode event fields stay below the encoded byte cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-observer-'));
  try {
    const observer = new RunObserver({ dataDir: root, job: job() });
    observer.trace({ type: 'command', step: 1, script: '\\'.repeat(20_000),
      stdout: '😀\\'.repeat(20_000), stderr: '\n'.repeat(20_000), exitCode: 0, durationMs: 1 });
    observer.finish('succeeded');
    const db = new DatabaseSync(join(root, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare("SELECT data_json FROM run_events WHERE type='command'").get() as { data_json: string };
      assert.ok(Buffer.byteLength(row.data_json) <= 16_384);
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      assert.equal(data.type, 'command');
      assert.equal(data.truncated, true);
      assert.ok((data.script as string).startsWith('\\'));
      assert.ok((data.stdout as string).startsWith('😀'));
      assert.ok((data.stderr as string).startsWith('\n'));
      assert.ok(Array.isArray(data.truncatedFields));
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an aborted command emits a timed error trace without changing legacy transcript events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-observer-'));
  try {
    const observer = new RunObserver({ dataDir: root, job: job() });
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const legacy: string[] = [];
    const trace: AgentTraceEvent[] = [];
    const running = runAgent({ workspace: root, prompt: 'Run slow.',
      model: new ScriptedModel([{ script: 'slow' }]), signal: controller.signal,
      capabilities: [{ name: 'slow', description: 'Wait', create: ({ signal }) => defineCommand('slow', async () => {
        started();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { stdout: '', stderr: '', exitCode: 0 };
      }) }],
      onEvent: (event) => { legacy.push(event.type); },
      onTrace: (event) => { trace.push(event); observer.trace(event); },
    });
    await entered;
    controller.abort(new Error('cancelled'));
    await assert.rejects(running, /cancelled/);
    assert.deepEqual(legacy, []);
    const failed = trace.find((entry) => entry.type === 'command-error');
    assert.equal(failed?.type, 'command-error');
    if (failed?.type === 'command-error') {
      assert.equal(failed.step, 1);
      assert.ok(failed.durationMs >= 0);
      assert.equal(failed.error, 'cancelled');
    }
    observer.finish('failed', { error: 'cancelled' });
    const db = new DatabaseSync(join(root, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT steps,failed_commands,command_ms FROM run_attempts WHERE id=?')
        .get(observer.id) as Record<string, number>;
      assert.equal(row.steps, 1);
      assert.equal(row.failed_commands, 1);
      assert.ok(row.command_ms >= 0);
      assert.ok(db.prepare("SELECT id FROM run_events WHERE type='command-error'").get());
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recording truncates once without losing the final database state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-observer-'));
  try {
    const observer = new RunObserver({ dataDir: root, job: job(), recording });
    for (let step = 1; step <= 30; step++) observer.trace({ type: 'command', step,
      script: 'echo lots', stdout: 'x'.repeat(8000), stderr: '', exitCode: 0, durationMs: 1 });
    observer.finish('succeeded', { summary: 'Done' });
    const cast = await readFile(observer.recordingPath!, 'utf8');
    assert.ok(Buffer.byteLength(cast) <= recording.maxBytes);
    assert.equal(cast.match(/Recording truncated at configured size limit/g)?.length, 1);
    const db = new DatabaseSync(join(root, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT steps,status,recording_truncated FROM run_attempts WHERE id=?').get(observer.id) as Record<string, unknown>;
      assert.deepEqual({ ...row }, { steps: 30, status: 'succeeded', recording_truncated: 1 });
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed recorder leaves a durable attempt and later completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-observer-'));
  try {
    await writeFile(join(root, 'recordings'), 'blocks the optional recorder');
    const errors: unknown[] = [];
    const observer = new RunObserver({ dataDir: root, job: job(), recording,
      onError: (error) => errors.push(error) });
    assert.equal(observer.recordingPath, null);
    observer.finish('failed', { error: 'Source clone failed' });
    assert.equal(errors.length, 1);
    const db = new DatabaseSync(join(root, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT status,error,recording_path FROM run_attempts WHERE id=?').get(observer.id) as Record<string, unknown>;
      assert.deepEqual({ ...row }, { status: 'failed', error: 'Source clone failed', recording_path: null });
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closing an unfinished attempt leaves a truthful partial trace for recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-observer-'));
  try {
    const observer = new RunObserver({ dataDir: root, job: job() });
    observer.trace({ type: 'model-start', call: 1 });
    observer.close();
    const db = new DatabaseSync(join(root, 'observability.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT status,phase,finished_at,model_calls FROM run_attempts WHERE id=?')
        .get(observer.id) as Record<string, unknown>;
      assert.deepEqual({ ...row }, { status: 'running', phase: 'model', finished_at: null, model_calls: 1 });
      assert.ok(db.prepare('SELECT id FROM run_events WHERE run_id=? AND type=?').get(observer.id, 'model-start'));
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
