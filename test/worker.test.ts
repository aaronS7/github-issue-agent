import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { IssueEvent } from '../src/events.js';
import { GitHubClient } from '../src/github.js';
import { ScriptedModel } from '../src/model.js';
import { DurableQueue, type OutboxEntry } from '../src/queue.js';
import { Worker } from '../src/worker.js';
import type { RunResult } from '../src/workspace.js';

class FakeGitHub extends GitHubClient {
  readonly delivered: OutboxEntry[] = [];
  fail = false;
  constructor() { super('test', 'http://127.0.0.1'); }
  override async deliver(effect: OutboxEntry): Promise<void> {
    this.delivered.push(effect);
    if (this.fail) throw new Error('fake GitHub outage');
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } }).trim();
}

async function fixture(feedback: boolean, maxAttempts = 1) {
  const root = await mkdtemp(join(tmpdir(), 'issue-worker-'));
  const source = join(root, 'source');
  git(root, 'init', '-q', source);
  await writeFile(join(source, 'README.md'), 'Base project\n');
  git(source, 'add', 'README.md');
  git(source, 'commit', '-q', '-m', 'base');
  const config = loadConfig({
    GITHUB_REPOSITORY: 'owner/repo', REPOSITORY_PATH: source,
    GITHUB_WEBHOOK_SECRET: 'test-secret', GITHUB_FEEDBACK: String(feedback),
    ...(feedback ? { GITHUB_TOKEN: 'test-token' } : {}),
    DATA_DIR: join(root, 'data'), MAX_ATTEMPTS: String(maxAttempts),
    MAX_STEPS: '5', RUN_TIMEOUT_MS: '30000', LEASE_MS: '3000',
  });
  const queue = new DurableQueue(config.database, { leaseMs: config.leaseMs, maxAttempts, baseBackoffMs: 0 });
  return { root, source, config, queue, close: async () => {
    queue.close();
    await rm(root, { recursive: true, force: true });
  } };
}

function issue(number: number, kind: 'issue' | 'comment' = 'issue'): IssueEvent {
  return {
    repository: 'owner/repo', issueNumber: number, title: `Issue ${number}`, body: 'Make a change',
    author: 'alice', labels: [], action: kind === 'issue' ? 'opened' : 'created', kind,
    ...(kind === 'comment' ? { comment: { id: 1000 + number, body: '/agent continue', author: 'alice' } } : {}),
    url: `https://github.com/owner/repo/issues/${number}`,
  };
}

function enqueue(queue: DurableQueue, deliveryId: string, payload: IssueEvent): number {
  return queue.enqueue({ deliveryId, repository: payload.repository, issueNumber: payload.issueNumber,
    eventKind: payload.kind === 'issue' ? 'issues.opened' : 'issue_comment.created', payload });
}

test('worker commits an issue edit, continues from that commit, and drains feedback', async () => {
  const f = await fixture(true);
  const github = new FakeGitHub();
  let sawPreviousSummary = false;
  const worker = new Worker({ queue: f.queue, config: f.config, github,
    createModel: (_job, event) => event.kind === 'issue'
      ? new ScriptedModel([
        { script: 'cat README.md' },
        { script: "printf 'first\\n' > feature.txt" },
        { script: 'github-comment "Implementation started"' },
        { text: 'Added the first version.' },
      ])
      : {
          complete: async (messages: readonly { content: string }[], signal: AbortSignal) => {
            signal.throwIfAborted();
            if (!sawPreviousSummary) {
              sawPreviousSummary = messages.some(({ content }) => content.includes('Its summary: Added the first version.'));
              return { script: 'cat feature.txt' };
            }
            if (!messages.some(({ content }) => content.includes('first\n'))) throw new Error('Previous file was not present');
            if (!messages.some(({ content }) => content.includes('printf'))) return { script: "printf 'second\\n' >> feature.txt" };
            return { text: 'Extended the feature.' };
          },
        },
  });
  try {
    const firstId = enqueue(f.queue, 'delivery-first', issue(42));
    assert.equal(await worker.processNext(), true);
    const firstJob = f.queue.getJob(firstId)!;
    assert.equal(firstJob.status, 'done');
    const first = firstJob.result as RunResult;
    assert.equal(await readFile(join(first.workspace, 'feature.txt'), 'utf8'), 'first\n');
    assert.equal(first.changed, true);
    assert.equal(existsSync(join(first.workspace, '.git')), false);
    assert.match(await readFile(first.patchPath, 'utf8'), /feature\.txt/);

    const followupId = enqueue(f.queue, 'delivery-followup', issue(42, 'comment'));
    assert.equal(await worker.processNext(), true);
    const followupJob = f.queue.getJob(followupId)!;
    assert.equal(followupJob.status, 'done');
    const followup = followupJob.result as RunResult;
    assert.equal(sawPreviousSummary, true);
    assert.equal(await readFile(join(followup.workspace, 'feature.txt'), 'utf8'), 'first\nsecond\n');
    assert.notEqual(followup.commit, first.commit);
    assert.equal(await readFile(join(f.source, 'README.md'), 'utf8'), 'Base project\n');

    while (await worker.processNextEffect()) { /* drain the durable outbox */ }
    assert.equal(f.queue.stats().outbox.done, 7);
    assert.equal(github.delivered.length, 7);
    assert.ok(github.delivered.some((effect) => effect.kind === 'comment' &&
      (effect.payload as { body?: string }).body === 'Implementation started'));
  } finally { await worker.stop(); await f.close(); }
});

test('two workers process separate issues concurrently in isolated checkouts', async () => {
  const f = await fixture(false);
  const createModel = (_job: unknown, event: IssueEvent) => new ScriptedModel([
    { script: `printf '${event.issueNumber}\\n' > issue.txt` },
    { text: `Implemented ${event.issueNumber}.` },
  ]);
  const firstWorker = new Worker({ queue: f.queue, config: f.config, createModel });
  const secondWorker = new Worker({ queue: f.queue, config: f.config, createModel });
  try {
    const firstId = enqueue(f.queue, 'issue-1', issue(1));
    const secondId = enqueue(f.queue, 'issue-2', issue(2));
    assert.deepEqual(await Promise.all([firstWorker.processNext(), secondWorker.processNext()]), [true, true]);
    const first = f.queue.getJob(firstId)!.result as RunResult;
    const second = f.queue.getJob(secondId)!.result as RunResult;
    assert.notEqual(first.workspace, second.workspace);
    assert.equal(await readFile(join(first.workspace, 'issue.txt'), 'utf8'), '1\n');
    assert.equal(await readFile(join(second.workspace, 'issue.txt'), 'utf8'), '2\n');
    assert.equal(existsSync(join(f.source, 'issue.txt')), false);
  } finally { await firstWorker.stop(); await secondWorker.stop(); await f.close(); }
});

test('failed run publishes no result and feedback failure leaves a successful job done', async () => {
  const f = await fixture(true);
  const github = new FakeGitHub();
  github.fail = true;
  const worker = new Worker({ queue: f.queue, config: f.config, github,
    createModel: (_job, event) => event.issueNumber === 1
      ? new ScriptedModel([{ script: 'touch .git' }, { text: 'Created forbidden entry.' }])
      : new ScriptedModel([{ script: "printf 'ok\\n' > done.txt" }, { text: 'Done.' }]),
  });
  try {
    const failedId = enqueue(f.queue, 'failed', issue(1));
    assert.equal(await worker.processNext(), true);
    assert.equal(f.queue.getJob(failedId)?.status, 'dead');
    assert.equal(f.queue.getJob(failedId)?.result, null);
    assert.equal(existsSync(join(f.config.dataDir, 'runs', String(failedId), 'result.json')), false);

    const successId = enqueue(f.queue, 'successful', issue(2));
    assert.equal(await worker.processNext(), true);
    assert.equal(f.queue.getJob(successId)?.status, 'done');
    assert.equal(await worker.processNextEffect(), true);
    assert.equal(f.queue.getJob(successId)?.status, 'done');
    assert.equal(await worker.processNext(), false);
    assert.ok(github.delivered.length > 0);
  } finally { await worker.stop(); await f.close(); }
});
