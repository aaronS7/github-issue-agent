import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DurableQueue } from '../src/queue.js';
import { createWebhookServer } from '../src/webhook.js';

const secret = 'webhook-test-secret';
const endpointEvent = {
  action: 'opened',
  issue: {
    number: 42,
    title: 'Add a thing',
    body: 'Please add a thing',
    html_url: 'https://github.com/acme/widgets/issues/42',
    user: { login: 'Alice', type: 'User' },
    labels: [{ name: 'enhancement' }],
  },
  repository: { full_name: 'acme/widgets' },
  sender: { login: 'Alice', type: 'User' },
};

type Response = { status: number; headers: IncomingHttpHeaders; body: string };

function signature(body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function request(port: number, options: {
  body: Buffer | string;
  event?: string;
  delivery?: string;
  sig?: string | null;
  headers?: Record<string, string>;
  chunked?: boolean;
}): Promise<Response> {
  const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  const headers: Record<string, string> = { ...options.headers };
  if (options.event !== undefined) headers['x-github-event'] = options.event;
  if (options.delivery !== undefined) headers['x-github-delivery'] = options.delivery;
  if (options.sig !== null) headers['x-hub-signature-256'] = options.sig ?? signature(body);
  if (!options.chunked) headers['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/webhooks/github', method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer<T>(
  work: (port: number, queue: DurableQueue) => Promise<T>,
  options: { repositories?: Set<string>; filters?: Parameters<typeof createWebhookServer>[0]['filters']; maxBodyBytes?: number } = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'issue-webhook-'));
  const queue = new DurableQueue(join(dir, 'queue.sqlite'));
  const server = createWebhookServer({
    queue, secret, repositories: options.repositories ?? new Set(['acme/widgets']),
    ...(options.filters ? { filters: options.filters } : {}),
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  try { return await work(address.port, queue); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function json(value: unknown): string { return JSON.stringify(value); }

function parse(body: string): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown>; }

test('verifies HMAC over raw body, persists valid issue, and deduplicates a concurrent redelivery', async () => {
  await withServer(async (port, queue) => {
    const raw = Buffer.from(json(endpointEvent));
    const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': signature(raw), 'content-type': 'application/json' };
    const send = () => request(port, { body: raw, headers });
    const [first, duplicate] = await Promise.all([send(), send()]);
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 202);
    assert.equal(parse(first.body).jobId, parse(duplicate.body).jobId);
    assert.equal(queue.stats().jobs.queued, 1);
    const job = queue.getJob(Number(parse(first.body).jobId));
    assert.equal(job?.repository, 'acme/widgets');
    assert.deepEqual(job?.payload, {
      repository: 'acme/widgets', issueNumber: 42, title: 'Add a thing', body: 'Please add a thing',
      author: 'Alice', labels: ['enhancement'], action: 'opened', kind: 'issue',
      url: 'https://github.com/acme/widgets/issues/42',
    });
  });
});

test('rejects missing and invalid signatures before parsing', async () => {
  await withServer(async (port, queue) => {
    const noSignature = await request(port, { body: '{invalid', sig: null });
    const badSignature = await request(port, { body: '{invalid', sig: 'sha256=' + '0'.repeat(64) });
    assert.equal(noSignature.status, 401);
    assert.equal(badSignature.status, 401);
    assert.equal(queue.stats().jobs.queued, 0);
  });
});

test('rejects malformed JSON and safely ignores malformed or unsupported events', async () => {
  await withServer(async (port, queue) => {
    const malformedJson = await request(port, { body: '{', event: 'issues', delivery: 'bad-json' });
    assert.equal(malformedJson.status, 400);
    const malformedPayload = await request(port, { body: json({ action: 'opened', issue: {} }), event: 'issues', delivery: 'bad-payload' });
    assert.equal(malformedPayload.status, 202);
    assert.equal(parse(malformedPayload.body).ignored, true);
    const unsupported = await request(port, { body: json(endpointEvent), event: 'push', delivery: 'push-event' });
    assert.equal(unsupported.status, 202);
    assert.equal(parse(unsupported.body).ignored, true);
    assert.equal(queue.stats().jobs.queued, 0);
  });
});

test('ignores disallowed repositories, pull requests, explicitly configured bot logins, and filtered events', async () => {
  await withServer(async (port, queue) => {
    const disallowed = await request(port, { body: json({ ...endpointEvent, repository: { full_name: 'other/repo' } }), event: 'issues', delivery: 'repo' });
    const pullRequest = await request(port, { body: json({ ...endpointEvent, issue: { ...endpointEvent.issue, pull_request: { url: 'https://api.github.com/pulls/42' } } }), event: 'issues', delivery: 'pr' });
    const bot = await request(port, { body: json({ ...endpointEvent, sender: { login: 'release-bot', type: 'User' } }), event: 'issues', delivery: 'bot' });
    assert.equal(parse(disallowed.body).ignored, true);
    assert.equal(parse(pullRequest.body).ignored, true);
    assert.equal(parse(bot.body).ignored, true);
    assert.equal(queue.stats().jobs.queued, 0);
  }, { filters: { botLogins: ['release-bot'], labels: ['enhancement'], authors: ['alice'] } });
});


test('accepts a bot-authored new issue when no bot-login exclusion is configured', async () => {
  await withServer(async (port, queue) => {
    const botIssue = { ...endpointEvent,
      issue: { ...endpointEvent.issue, user: { login: 'dependabot[bot]', type: 'Bot' } },
      sender: { login: 'dependabot[bot]', type: 'Bot' },
    };
    const response = await request(port, { body: json(botIssue), event: 'issues', delivery: 'bot-issue' });
    assert.equal(response.status, 202);
    assert.equal(queue.stats().jobs.queued, 1);
  });
});

test('requires command-prefixed follow-up comments and ignores agent-marker comments', async () => {
  await withServer(async (port, queue) => {
    const comment = (body: string, id: number) => ({
      action: 'created', issue: endpointEvent.issue, repository: endpointEvent.repository,
      sender: { login: 'Bob', type: 'User' },
      comment: { id, body, user: { login: 'Bob', type: 'User' } },
    });
    const ordinary = await request(port, { body: json(comment('please help', 1)), event: 'issue_comment', delivery: 'comment-1' });
    const marker = await request(port, { body: json(comment('/agent <!-- just-bash-agent: done -->', 2)), event: 'issue_comment', delivery: 'comment-2' });
    const command = await request(port, { body: json(comment('/agent inspect this', 3)), event: 'issue_comment', delivery: 'comment-3' });
    assert.equal(parse(ordinary.body).ignored, true);
    assert.equal(parse(marker.body).ignored, true);
    assert.equal(command.status, 202);
    assert.equal(queue.stats().jobs.queued, 1);
  });
});

test('rejects declared and chunked bodies that exceed the configured limit', async () => {
  await withServer(async (port) => {
    const declared = await request(port, { body: 'x'.repeat(200), headers: { 'content-type': 'application/json' } });
    assert.equal(declared.status, 413);
    const chunked = await request(port, { body: 'x'.repeat(200), headers: { 'content-type': 'application/json' }, chunked: true });
    assert.equal(chunked.status, 413);
  }, { maxBodyBytes: 128 });
});

test('rejects missing or invalid delivery headers after signature validation', async () => {
  await withServer(async (port) => {
    const missing = await request(port, { body: json(endpointEvent), event: 'issues', delivery: undefined });
    const invalid = await request(port, { body: json(endpointEvent), event: 'issues', delivery: '../delivery' });
    assert.equal(missing.status, 400);
    assert.equal(invalid.status, 400);
  });
});
