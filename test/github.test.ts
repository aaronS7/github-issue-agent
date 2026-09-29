import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgent } from '../src/agent.js';
import type { IssueEvent } from '../src/events.js';
import { GitHubClient } from '../src/github.js';
import { feedbackCapabilities } from '../src/hooks.js';
import { ScriptedModel } from '../src/model.js';
import { DurableQueue, type OutboxEntry } from '../src/queue.js';

interface RecordedRequest { method: string; path: string; body: unknown }

function entry(kind: 'comment' | 'reaction', payload: unknown): OutboxEntry {
  return { id: 7, jobId: 2, key: 'feedback-1', kind, payload, attempts: 1, leaseToken: 'lease' };
}

async function localApi(handler: (request: RecordedRequest, response: ServerResponse) => void) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const record = { method: request.method ?? '', path: request.url ?? '', body };
    requests.push(record);
    handler(record, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    client: new GitHubClient('test-token', `http://127.0.0.1:${address.port}`),
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const signal = () => new AbortController().signal;

test('a retried comment finds its durable marker after 100-comment pagination', async () => {
  let postedBody = '';
  const api = await localApi((request, response) => {
    if (request.method === 'GET' && request.path.endsWith('page=1')) {
      json(response, Array.from({ length: 100 }, (_, index) => ({ body: `older ${index}` })));
    } else if (request.method === 'GET' && request.path.endsWith('page=2')) {
      json(response, postedBody ? [{ body: postedBody }] : []);
    } else if (request.method === 'POST' && request.path === '/repos/owner/repo/issues/42/comments') {
      postedBody = String((request.body as { body: string }).body);
      json(response, { id: 123 }, 201);
    } else {
      json(response, { message: 'unexpected route' }, 404);
    }
  });
  try {
    const outbox = entry('comment', { repository: 'owner/repo', issueNumber: 42, body: 'A durable reply' });
    await api.client.deliver(outbox, 'delivery-123', signal());
    assert.match(postedBody, /^A durable reply\n\n<!-- just-bash-agent:[0-9a-f]{64} -->$/);
    await api.client.deliver(outbox, 'delivery-123', signal());
    assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), [
      'GET /repos/owner/repo/issues/42/comments?per_page=100&page=1',
      'GET /repos/owner/repo/issues/42/comments?per_page=100&page=2',
      'POST /repos/owner/repo/issues/42/comments',
      'GET /repos/owner/repo/issues/42/comments?per_page=100&page=1',
      'GET /repos/owner/repo/issues/42/comments?per_page=100&page=2',
    ]);
  } finally { await api.close(); }
});

test('issue and comment reactions use their respective GitHub endpoints', async () => {
  const api = await localApi((_request, response) => json(response, { id: 1 }, 201));
  try {
    await api.client.deliver(entry('reaction', {
      repository: 'owner/repo', issueNumber: 42, content: 'eyes',
    }), 'delivery', signal());
    await api.client.deliver(entry('reaction', {
      repository: 'owner/repo', issueNumber: 42, commentId: 987, content: 'heart',
    }), 'delivery', signal());
    assert.deepEqual(api.requests.map(({ method, path, body }) => ({ method, path, body })), [
      { method: 'POST', path: '/repos/owner/repo/issues/42/reactions', body: { content: 'eyes' } },
      { method: 'POST', path: '/repos/owner/repo/issues/comments/987/reactions', body: { content: 'heart' } },
    ]);
  } finally { await api.close(); }
});

test('API failures reject and malformed feedback makes no request', async () => {
  const api = await localApi((_request, response) => json(response, { message: 'unavailable' }, 503));
  try {
    await assert.rejects(api.client.deliver(entry('comment', {
      repository: 'owner/repo', issueNumber: 42, body: 'Reply',
    }), 'delivery', signal()), /HTTP 503/);
    assert.equal(api.requests.length, 1, JSON.stringify(api.requests));
    for (const payload of [
      { repository: '../bad', issueNumber: 42, body: 'Reply' },
      { repository: 'owner/repo', issueNumber: 0, body: 'Reply' },
      { repository: 'owner/repo', issueNumber: 42, body: '   ' },
    ]) await assert.rejects(api.client.deliver(entry('comment', payload), 'delivery', signal()));
    for (const payload of [
      { repository: 'owner/repo', issueNumber: 42, content: 'invalid' },
      { repository: 'owner/repo', issueNumber: 42, commentId: -1, content: 'heart' },
    ]) await assert.rejects(api.client.deliver(entry('reaction', payload), 'delivery', signal()));
    assert.equal(api.requests.length, 1, JSON.stringify(api.requests));
  } finally { await api.close(); }
});

test('feedback capability commands enqueue effects and reject a stale lease', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'issue-feedback-'));
  const queue = new DurableQueue(':memory:');
  const issue: IssueEvent = {
    repository: 'owner/repo', issueNumber: 42, title: 'Fix', body: 'Please fix', author: 'alice',
    labels: [], action: 'created', kind: 'comment',
    comment: { id: 987, body: '/agent fix', author: 'alice' }, url: 'https://github.com/owner/repo/issues/42',
  };
  const id = queue.enqueue({
    deliveryId: 'delivery-1', repository: issue.repository, issueNumber: issue.issueNumber,
    eventKind: 'issue_comment.created', payload: issue,
  });
  const job = queue.claim()!;
  const capabilities = feedbackCapabilities(queue, job, issue);
  try {
    await runAgent({
      workspace, prompt: 'Leave feedback.',
      model: new ScriptedModel([
        { script: 'printf "A note from bash" | github-comment' },
        { script: 'github-react heart' },
        { text: 'Queued feedback.' },
      ]), capabilities,
    });
    assert.deepEqual(queue.listOutbox().map((effect) => effect.payload), [
      { repository: 'owner/repo', issueNumber: 42, commentId: 987, content: 'heart' },
      { repository: 'owner/repo', issueNumber: 42, commentId: 987, body: 'A note from bash' },
    ]);
    assert.equal(queue.complete(id, job.leaseToken!), true);
    const originalCount = queue.listOutbox().length;
    const stale = await runAgent({
      workspace, prompt: 'Try stale feedback.',
      model: new ScriptedModel([{ script: 'github-comment stale' }, { text: 'Done.' }]),
      capabilities,
    });
    assert.equal(stale.transcript[0]?.type, 'command');
    if (stale.transcript[0]?.type === 'command') assert.notEqual(stale.transcript[0].exitCode, 0);
    assert.equal(queue.listOutbox().length, originalCount);
  } finally {
    queue.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('replaying capability commands after a job retry reuses durable effect keys', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'issue-feedback-retry-'));
  const queue = new DurableQueue(':memory:', { baseBackoffMs: 0 });
  const issue: IssueEvent = {
    repository: 'owner/repo', issueNumber: 7, title: 'Reply', body: '', author: 'alice',
    labels: [], action: 'opened', kind: 'issue', url: 'https://github.com/owner/repo/issues/7',
  };
  const id = queue.enqueue({ deliveryId: 'retry-delivery', repository: issue.repository,
    issueNumber: issue.issueNumber, eventKind: 'issues.opened', payload: issue });
  try {
    const first = queue.claim()!;
    await runAgent({ workspace, prompt: 'Reply twice.', capabilities: feedbackCapabilities(queue, first, issue),
      model: new ScriptedModel([{ script: 'github-comment same; github-comment same' }, { text: 'Done.' }]) });
    assert.equal(queue.listOutbox().length, 2);
    const keys = queue.listOutbox().map((effect) => effect.key);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(queue.fail(id, first.leaseToken!, 'retry'), 'queued');
    const second = queue.claim()!;
    assert.equal(second.attempts, 2);
    await runAgent({ workspace, prompt: 'Reply twice.', capabilities: feedbackCapabilities(queue, second, issue),
      model: new ScriptedModel([{ script: 'github-comment same; github-comment same' }, { text: 'Done.' }]) });
    assert.deepEqual(queue.listOutbox().map((effect) => effect.key), keys);
  } finally {
    queue.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
