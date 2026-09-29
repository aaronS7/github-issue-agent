import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DurableQueue, type IssueEvent } from '../src/queue.js';

const event = (deliveryId: string, issueNumber = 1): IssueEvent => ({
  deliveryId, repository: 'owner/repo', issueNumber, eventKind: 'issues.opened',
  payload: { title: deliveryId },
});

function fixture(options: { leaseMs?: number; maxAttempts?: number; baseBackoffMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-queue-'));
  let time = 1_000;
  const path = join(dir, 'queue.sqlite');
  const open = () => new DurableQueue(path, { leaseMs: 100, maxAttempts: 3,
    baseBackoffMs: 10, ...options, now: () => time });
  return { path, open, advance: (ms: number) => { time += ms; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('deduplicates deliveries and persists jobs across reopen', () => {
  const f = fixture();
  try {
    const q1 = f.open();
    const id = q1.enqueue(event('delivery-1'));
    q1.close();
    const q2 = f.open();
    assert.equal(q2.enqueue(event('delivery-1')), id);
    assert.equal(q2.stats().jobs.queued, 1);
    const job = q2.claim();
    assert.equal(job?.id, id);
    assert.deepEqual(job?.payload, { title: 'delivery-1' });
    assert.equal(q2.complete(id, job!.leaseToken!), true);
    q2.close();
    const q3 = f.open();
    assert.equal(q3.getJob(id)?.status, 'done');
    assert.equal(q3.claim(), null);
    q3.close();
  } finally { f.cleanup(); }
});

test('claims atomically across connections and serializes events for an issue', () => {
  const f = fixture();
  try {
    const a = f.open();
    const b = f.open();
    const first = a.enqueue(event('first', 1));
    const second = a.enqueue(event('second', 1));
    const separate = a.enqueue(event('third', 2));
    const c1 = a.claim()!;
    const c2 = b.claim()!;
    assert.equal(c1.id, first);
    assert.equal(c2.id, separate);
    assert.equal(a.claim(), null);
    assert.equal(a.complete(first, c1.leaseToken!), true);
    assert.equal(b.claim()?.id, second);
    a.close(); b.close();
  } finally { f.cleanup(); }
});

test('expired leases recover after backoff and reject the former owner', () => {
  const f = fixture();
  try {
    const a = f.open();
    const b = f.open();
    const id = a.enqueue(event('lease'));
    const old = a.claim()!;
    f.advance(100);
    assert.equal(b.claim(), null);
    assert.equal(a.heartbeat(id, old.leaseToken!), false);
    f.advance(10);
    const current = b.claim()!;
    assert.equal(current.id, id);
    assert.notEqual(current.leaseToken, old.leaseToken);
    assert.equal(a.complete(id, old.leaseToken!), false);
    assert.equal(a.fail(id, old.leaseToken!, 'late'), null);
    assert.equal(b.complete(id, current.leaseToken!), true);
    a.close(); b.close();
  } finally { f.cleanup(); }
});

test('failures back off, dead-letter, and allow manual retry', () => {
  const f = fixture({ maxAttempts: 2, baseBackoffMs: 20 });
  try {
    const q = f.open();
    const id = q.enqueue(event('retry'));
    const first = q.claim()!;
    assert.equal(q.fail(id, first.leaseToken!, 'one'), 'queued');
    assert.equal(q.claim(), null);
    f.advance(20);
    const second = q.claim()!;
    assert.equal(second.attempts, 2);
    assert.equal(q.fail(id, second.leaseToken!, 'two'), 'dead');
    assert.equal(q.getJob(id)?.status, 'dead');
    assert.equal(q.retryJob(id), true);
    assert.equal(q.retryJob(id), false);
    assert.equal(q.claim()?.attempts, 1);
    q.close();
  } finally { f.cleanup(); }
});

test('completion and lifecycle outbox effects commit together with ordered retries', () => {
  const f = fixture();
  try {
    const q = f.open();
    const id = q.enqueue(event('effects'), [{ kind: 'reaction', key: 'queued', payload: { content: 'eyes' } }]);
    const job = q.claim()!;
    assert.equal(q.enqueueEffects(id, job.leaseToken!, [
      { kind: 'comment', key: 'started', payload: { body: 'started' } },
      { kind: 'comment', key: 'started', payload: { body: 'duplicate' } },
    ]), true);
    assert.equal(q.complete(id, job.leaseToken!, [
      { kind: 'comment', key: 'done', payload: { body: 'done' } },
    ]), true);
    assert.equal(q.listOutbox().length, 3);
    assert.equal(q.complete(id, job.leaseToken!), false);
    const first = q.claimOutbox()!;
    assert.equal(first.kind, 'reaction');
    assert.equal(q.claimOutbox(), null);
    assert.equal(q.failOutbox(first.id, first.leaseToken, 'rate limit'), 'queued');
    assert.equal(q.claimOutbox(), null);
    f.advance(10);
    const retry = q.claimOutbox()!;
    assert.equal(retry.id, first.id);
    assert.equal(q.completeOutbox(first.id, first.leaseToken), false);
    assert.equal(q.completeOutbox(retry.id, retry.leaseToken), true);
    assert.deepEqual([q.claimOutbox()?.payload, q.claimOutbox()], [{ body: 'started' }, null]);
    q.close();
  } finally { f.cleanup(); }
});

test('invalid effects roll back the job transition', () => {
  const f = fixture();
  try {
    const q = f.open();
    const id = q.enqueue(event('atomic'));
    const job = q.claim()!;
    assert.throws(() => q.complete(id, job.leaseToken!, [
      { kind: 'comment', payload: { body: 'first' } },
      { kind: 'comment', payload: 1n },
    ]));
    assert.equal(q.getJob(id)?.status, 'running');
    assert.equal(q.listOutbox().length, 0);
    assert.equal(q.complete(id, job.leaseToken!), true);
    q.close();
  } finally { f.cleanup(); }
});

test('finds the latest completed issue job and redrives dead outbox entries', () => {
  const f = fixture({ maxAttempts: 1 });
  try {
    const q = f.open();
    assert.equal(q.latestCompleted('owner/repo', 1), null);
    const firstId = q.enqueue(event('first-result'));
    const first = q.claim()!;
    assert.equal(q.complete(firstId, first.leaseToken!), true);
    const secondId = q.enqueue(event('second-result'));
    const second = q.claim()!;
    assert.equal(q.complete(secondId, second.leaseToken!, [
      { kind: 'comment', payload: { body: 'result' } },
    ]), true);
    assert.equal(q.latestCompleted('owner/repo', 1)?.id, secondId);
    const effect = q.claimOutbox()!;
    assert.equal(q.heartbeatOutbox(effect.id, effect.leaseToken), true);
    assert.equal(q.failOutbox(effect.id, effect.leaseToken, 'failure'), 'dead');
    assert.equal(q.retryOutbox(effect.id), true);
    assert.equal(q.retryOutbox(effect.id), false);
    assert.equal(q.claimOutbox()?.id, effect.id);
    q.close();
  } finally { f.cleanup(); }
});

test('latest completed follows completion order when an older dead job is retried', () => {
  const f = fixture({ maxAttempts: 1 });
  try {
    const q = f.open();
    const olderId = q.enqueue(event('older'));
    const newerId = q.enqueue(event('newer'));
    const older = q.claim()!;
    assert.equal(q.fail(olderId, older.leaseToken!, 'first attempt failed'), 'dead');
    const newer = q.claim()!;
    assert.equal(newer.id, newerId);
    assert.equal(q.complete(newerId, newer.leaseToken!, [], { commit: 'newer' }), true);
    assert.equal(q.latestCompleted('owner/repo', 1)?.id, newerId);
    assert.equal(q.retryJob(olderId), true);
    const olderRetry = q.claim()!;
    assert.equal(olderRetry.id, olderId);
    assert.equal(q.complete(olderId, olderRetry.leaseToken!, [], { commit: 'older-retry' }), true);
    assert.equal(q.latestCompleted('owner/repo', 1)?.id, olderId);
    assert.deepEqual(q.latestCompleted('owner/repo', 1)?.result, { commit: 'older-retry' });
    q.close();
  } finally { f.cleanup(); }
});

test('stale owners cannot commit a result or effects after lease recovery', () => {
  const f = fixture({ baseBackoffMs: 0 });
  try {
    const a = f.open();
    const b = f.open();
    const id = a.enqueue(event('fenced-result'));
    const old = a.claim()!;
    f.advance(100);
    const current = b.claim()!;
    assert.equal(a.complete(id, old.leaseToken!, [
      { kind: 'comment', payload: { body: 'stale' } },
    ], { commit: 'old' }), false);
    assert.equal(b.complete(id, current.leaseToken!, [
      { kind: 'comment', payload: { body: 'current' } },
    ], { commit: 'current' }), true);
    assert.deepEqual(b.latestCompleted('owner/repo', 1)?.result, { commit: 'current' });
    assert.deepEqual(b.listOutbox().map(effect => effect.payload), [{ body: 'current' }]);
    a.close(); b.close();
  } finally { f.cleanup(); }
});

test('SIGKILL after claim leaves a durable job that recovers on reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/queue.ts', import.meta.url))).href;
    const script = `const { DurableQueue } = await import(${JSON.stringify(moduleUrl)});
      const q = new DurableQueue(${JSON.stringify(path)}, { leaseMs: 100, baseBackoffMs: 0,
        now: () => 1000 });
      q.enqueue(${JSON.stringify(event('crash'))});
      q.claim();
      process.stdout.write('claimed\\n');
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => { throw new Error('Child exited before claiming a job'); }),
      ]);
      child.kill('SIGKILL');
      const [, signal] = await once(child, 'exit');
      assert.equal(signal, 'SIGKILL');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    const q = new DurableQueue(path, { leaseMs: 30_000, baseBackoffMs: 0,
      now: () => 2_000 });
    const recovered = q.claim();
    assert.equal(recovered?.deliveryId, 'crash');
    assert.equal(recovered?.attempts, 2);
    assert.equal(q.complete(recovered!.id, recovered!.leaseToken!, [], { survived: true }), true);
    q.close();
    const reopened = new DurableQueue(path);
    assert.deepEqual(reopened.latestCompleted('owner/repo', 1)?.result, { survived: true });
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('online backup is consistent and refuses to replace an existing file', async () => {
  const f = fixture();
  try {
    const q = f.open();
    q.enqueue(event('backup-first'));
    const destination = `${f.path}.backup`;
    await q.backup(destination);
    q.enqueue(event('backup-second'));
    await assert.rejects(q.backup(destination), { code: 'EEXIST' });
    const restored = new DurableQueue(destination);
    assert.equal(restored.listJobs().length, 1);
    assert.equal(restored.listJobs()[0]?.deliveryId, 'backup-first');
    restored.close(); q.close();
  } finally { f.cleanup(); }
});
