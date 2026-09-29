import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitHubPoller } from '../src/github-poller.js';
import { DurableQueue } from '../src/queue.js';

const start = Date.parse('2026-09-28T12:00:00Z');
const repo = 'acme/widgets';
const issue = (number: number, updated = '2026-09-28T12:01:00Z', extras: Record<string, unknown> = {}) => ({
  id: number + 1000, number, state: 'open', title: `Issue ${number}`, body: 'Body',
  html_url: `https://github.com/acme/widgets/issues/${number}`, user: { login: 'Alice', type: 'User' },
  labels: [{ name: 'agent' }], created_at: updated, updated_at: updated, ...extras,
});
const comment = (id: number, number: number, body = '/agent go', extras: Record<string, unknown> = {}) => ({
  id, body, user: { login: 'Bob', type: 'User' }, created_at: '2026-09-28T12:02:00Z',
  updated_at: '2026-09-28T12:02:00Z', issue_url: `https://api.github.com/repos/${repo}/issues/${number}`,
  ...extras,
});
const response = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
function queueWithState() {
  const queue = new DurableQueue(':memory:');
  return { queue, state: () => queue.getIngestionState(`github-poll:https://api.github.com:${repo}`) };
}
function poller(queue: DurableQueue, fetcher: typeof fetch, now = () => start, filters?: { labels?: string[] }) {
  return new GitHubPoller({ queue, auth: 'token', repository: repo, fetch: fetcher, now,
    ...(filters ? { filters } : {}) });
}

test('first poll stores cutoff, queues updated open issues and new commands, then restart deduplicates', async () => {
  const { queue, state } = queueWithState();
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer token');
    if (url.includes('/issues/comments?')) return response([
      comment(500, 1), comment(501, 1, '/agent old', { created_at: '2026-09-28T11:59:00Z' }),
      comment(502, 1, 'hello'), comment(503, 1, '/agent bot', { user: { login: 'robot', type: 'Bot' } }),
    ]);
    if (url.endsWith('/issues/1')) return response(issue(1));
    if (url.includes('/issues?')) return response([
      issue(1), issue(2, '2026-09-28T11:59:00Z'),
      issue(3, '2026-09-28T12:01:00Z', { pull_request: { url: 'https://api.github.com/pulls/3' } }),
      issue(4, '2026-09-28T12:01:00Z', { state: 'closed' }),
    ]);
    throw new Error(`Unexpected test URL: ${url}`);
  };
  try {
    assert.deepEqual(await poller(queue, fetcher).pollOnce(), { issues: 4, comments: 4, queued: 2 });
    assert.equal(queue.listJobs().length, 2);
    assert.deepEqual(queue.listJobs().map((job) => job.deliveryId.replace(/^poll:[a-f0-9]{32}:/, 'poll:')).sort(),
      ['poll:acme/widgets:comment:500', 'poll:acme/widgets:issue:1']);
    assert.equal((state() as Record<string, unknown>).startedAt, '2026-09-28T12:00:00.000Z');
    assert.ok(urls[0]?.includes('state=all'));
    assert.equal(new URL(urls[0]!).searchParams.get('since'), '2026-09-28T11:59:59.000Z');
    assert.deepEqual(await poller(queue, fetcher).pollOnce(), { issues: 4, comments: 4, queued: 0 });
    assert.equal(queue.listJobs().length, 2);
  } finally { queue.close(); }
});

test('page two failure preserves issue cursor and rerun commits every item once', async () => {
  const { queue, state } = queueWithState();
  let fail = true;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/issues/comments?')) return response([]);
    if (url.includes('page=2')) return fail ? response({ message: 'failed' }, { status: 500 }) : response([issue(2)]);
    if (url.includes('/issues?')) {
      const next = new URL(url.replace('/repos/acme/widgets/', '/repos/Acme/Widgets/'));
      next.searchParams.set('page', '2');
      return response([issue(1)], { headers: { link: `<${next.href}>; rel="next"` } });
    }
    throw new Error('Unexpected URL');
  };
  try {
    await assert.rejects(poller(queue, fetcher).pollOnce(), /GitHub polling failed/);
    assert.equal((state() as { issuesSince: string }).issuesSince, '2026-09-28T12:00:00.000Z');
    assert.equal(queue.listJobs().length, 1);
    fail = false;
    assert.deepEqual(await poller(queue, fetcher).pollOnce(), { issues: 2, comments: 0, queued: 1 });
    assert.equal(queue.listJobs().length, 2);
  } finally { queue.close(); }
});

test('single page ETag allows safe 304 and updated existing issue qualifies once', async () => {
  const { queue } = queueWithState();
  let issueCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/issues/comments?')) return response([]);
    if (url.includes('/issues?')) {
      issueCalls++;
      if (issueCalls === 3) {
        assert.equal((init?.headers as Record<string, string>)['if-none-match'], '"v1"');
        return new Response(null, { status: 304 });
      }
      return response([issue(10, '2026-09-28T12:01:00Z',
        { created_at: '2026-09-01T00:00:00Z' })], { headers: { etag: '"v1"' } });
    }
    throw new Error('Unexpected URL');
  };
  try {
    await poller(queue, fetcher).pollOnce();
    // The first cursor advance changes `since`; the next complete single page
    // establishes an ETag for that new query.
    await poller(queue, fetcher).pollOnce();
    await poller(queue, fetcher).pollOnce();
    assert.equal(queue.listJobs().length, 1);
  } finally { queue.close(); }
});

test('rate-limit deadline is persisted and prevents an immediate retry', async () => {
  const { queue, state } = queueWithState();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response({ message: 'slow down' },
    { status: 429, headers: { 'retry-after': '120' } }); };
  try {
    await assert.rejects(poller(queue, fetcher).pollOnce(), /GitHub polling failed/);
    assert.equal(calls, 1);
    assert.equal((state() as { retryAfter: string }).retryAfter, '2026-09-28T12:02:00.000Z');
    assert.deepEqual(await poller(queue, fetcher).pollOnce(), { issues: 0, comments: 0, queued: 0 });
    assert.equal(calls, 1);
  } finally { queue.close(); }
});

test('403 primary rate limit and server poll interval persist', async () => {
  const { queue, state } = queueWithState();
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    if (calls === 1) return response({ message: 'rate limit' }, { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((start + 180_000) / 1000),
        'x-poll-interval': '90' } });
    if (String(input).includes('/issues/comments?')) return response([]);
    return response([]);
  };
  try {
    await assert.rejects(poller(queue, fetcher).pollOnce(), /GitHub polling failed/);
    assert.equal((state() as { retryAfter: string }).retryAfter, '2026-09-28T12:03:00.000Z');
    assert.equal((state() as { serverPollIntervalMs: number }).serverPollIntervalMs, 90_000);
    assert.deepEqual(await poller(queue, fetcher).pollOnce(), { issues: 0, comments: 0, queued: 0 });
    assert.equal(calls, 1);
  } finally { queue.close(); }
});

test('401 invalidates installation token once and retries', async () => {
  const { queue } = queueWithState();
  let invalidated = '';
  let issued = 0;
  const auth = { getToken: async () => ++issued === 1 ? 'old' : 'new', invalidate: (token: string) => { invalidated = token; } };
  const fetcher: typeof fetch = async (input, init) => {
    if ((init?.headers as Record<string, string>).authorization === 'Bearer old') return response({}, { status: 401 });
    if (String(input).includes('/issues/comments?')) return response([]);
    return response([issue(1)]);
  };
  try {
    const agent = new GitHubPoller({ queue, auth, repository: repo, fetch: fetcher, now: () => start });
    await agent.pollOnce();
    assert.equal(invalidated, 'old');
    assert.equal(queue.listJobs().length, 1);
  } finally { queue.close(); }
});

test('rejects cross-origin pagination and comment parent URLs without leaking token', async () => {
  for (const mode of ['pagination', 'parent']) {
    const { queue } = queueWithState();
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/issues?')) return mode === 'pagination'
        ? response([issue(1)], { headers: { link: '<https://evil.example/steal>; rel="next"' } })
        : response([]);
      if (url.includes('/issues/comments?')) return response([comment(7, 1, '/agent go',
        { issue_url: 'https://evil.example/repos/acme/widgets/issues/1' })]);
      throw new Error('Unexpected request');
    };
    try {
      await assert.rejects(poller(queue, fetcher).pollOnce(), /GitHub polling failed/);
      assert.equal(queue.listJobs().length, mode === 'pagination' ? 0 : 0);
    } finally { queue.close(); }
  }
});

test('stop aborts a pending API request', async () => {
  const { queue } = queueWithState();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    entered();
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const agent = poller(queue, fetcher);
  agent.start();
  await started;
  await agent.stop();
  queue.close();
});

test('SQLite cursor and delivery dedup survive reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'github-poller-'));
  const database = join(directory, 'queue.sqlite');
  const fetcher: typeof fetch = async (input) => String(input).includes('/issues/comments?')
    ? response([]) : response([issue(19)]);
  try {
    const first = new DurableQueue(database);
    try { await poller(first, fetcher).pollOnce(); } finally { first.close(); }
    const reopened = new DurableQueue(database);
    try {
      assert.equal(reopened.listJobs().length, 1);
      assert.equal((reopened.getIngestionState(`github-poll:https://api.github.com:${repo}`) as
        { issuesSince: string }).issuesSince, '2026-09-28T12:01:00.000Z');
      await poller(reopened, fetcher).pollOnce();
      assert.equal(reopened.listJobs().length, 1);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('initial cutoff rounds down to GitHub timestamp precision and accepts canonical URL casing', async () => {
  const { queue, state } = queueWithState();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/issues/comments?')) return response([comment(99, 1, '/agent go', {
      created_at: '2026-09-28T12:00:00Z', updated_at: '2026-09-28T12:00:00Z',
      issue_url: 'https://api.github.com/repos/Acme/Widgets/issues/1',
    })]);
    if (url.endsWith('/issues/1')) return response(issue(1));
    if (url.includes('/issues?')) return response([]);
    throw new Error('Unexpected URL');
  };
  try {
    assert.deepEqual(await poller(queue, fetcher, () => start + 500).pollOnce(),
      { issues: 0, comments: 1, queued: 1 });
    assert.equal((state() as { startedAt: string }).startedAt, '2026-09-28T12:00:00.000Z');
  } finally { queue.close(); }
});

test('Retry-After over one hour is preserved without timer overflow', async () => {
  const { queue, state } = queueWithState();
  const fetcher: typeof fetch = async () => response({}, { status: 429, headers: { 'retry-after': '7200' } });
  try {
    await assert.rejects(poller(queue, fetcher).pollOnce(), /GitHub polling failed/);
    assert.equal((state() as { retryAfter: string }).retryAfter, '2026-09-28T14:00:00.000Z');
  } finally { queue.close(); }
});

test('X-Poll-Interval over one hour prevents requests before its persisted deadline', async () => {
  const { queue, state } = queueWithState();
  let current = start, calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return response([], { headers: { 'x-poll-interval': '7200' } });
  };
  try {
    await poller(queue, fetcher, () => current).pollOnce();
    assert.equal((state() as { serverPollUntil: string }).serverPollUntil, '2026-09-28T14:00:00.000Z');
    assert.equal(calls, 2);
    current += 3_600_000;
    assert.deepEqual(await poller(queue, fetcher, () => current).pollOnce(),
      { issues: 0, comments: 0, queued: 0 });
    assert.equal(calls, 2);
    current += 3_600_001;
    await poller(queue, fetcher, () => current).pollOnce();
    assert.equal(calls, 4);
  } finally { queue.close(); }
});

test('poll filters permit a later label match, ignore issue actions, and skip unrelated comments', async () => {
  const { queue } = queueWithState();
  let round = 0, parentCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/issues/1')) { parentCalls++; return response(issue(1)); }
    if (url.includes('/issues/comments?')) return response([
      comment(100, 1, 'ordinary'), comment(101, 1, '/agent bot', { user: { login: 'bot', type: 'Bot' } }),
      comment(102, 1, '/agent <!-- just-bash-agent: marker -->'),
    ]);
    if (url.includes('/issues?')) return response([
      issue(1, round === 0 ? '2026-09-28T12:01:00Z' : '2026-09-28T12:02:00Z',
        { labels: round === 0 ? [] : [{ name: 'agent' }] }),
      issue(2, '2026-09-28T12:02:00Z', { user: { login: 'Other' } }),
    ]);
    throw new Error('Unexpected URL');
  };
  const make = () => new GitHubPoller({ queue, auth: 'token', repository: repo, now: () => start,
    fetch: fetcher, filters: { labels: ['agent'], authors: ['Alice'], issueActions: [] } });
  try {
    assert.equal((await make().pollOnce()).queued, 0);
    round = 1;
    assert.equal((await make().pollOnce()).queued, 1);
    assert.equal((await make().pollOnce()).queued, 0);
    assert.equal(parentCalls, 0);
    assert.equal(queue.listJobs().length, 1);
  } finally { queue.close(); }
});

test('new command comments on closed issues queue while closed issues and ordinary comments do not', async () => {
  const { queue } = queueWithState();
  let parentCalls = 0;
  const closed = issue(5, '2026-09-28T12:01:00Z', { state: 'closed' });
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/issues/comments?')) return response([
      comment(201, 5, 'ordinary'), comment(202, 5, '/agent investigate'),
    ]);
    if (url.endsWith('/issues/5')) { parentCalls++; return response(closed); }
    if (url.includes('/issues?')) return response([closed]);
    throw new Error('Unexpected URL');
  };
  try {
    assert.deepEqual(await poller(queue, fetcher).pollOnce(), { issues: 1, comments: 2, queued: 1 });
    assert.equal(parentCalls, 1);
    assert.equal(queue.listJobs().length, 1);
    assert.equal(queue.listJobs()[0]?.eventKind, 'comment');
  } finally { queue.close(); }
});

test('corrupt checkpoint fails before timers start', () => {
  const { queue } = queueWithState();
  try {
    queue.setIngestionState(`github-poll:https://api.github.com:${repo}`, { version: 1, startedAt: 'bad' });
    const agent = poller(queue, async () => response([]));
    assert.throws(() => agent.start(), /Invalid GitHub poll cursor/);
  } finally { queue.close(); }
});
