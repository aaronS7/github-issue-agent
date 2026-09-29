import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { GitHubAppAuth } from '../src/github-auth.js';
import { GitHubClient } from '../src/github.js';
import type { OutboxEntry } from '../src/queue.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const initialNow = 1_800_000_000_000;

interface Call { method: string; path: string; authorization: string; body: unknown }

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function localApi(handler: (call: Call, response: ServerResponse) => void) {
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call = { method: request.method ?? '', path: request.url ?? '',
      authorization: request.headers.authorization ?? '',
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined };
    calls.push(call);
    handler(call, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { calls, baseUrl, close: () => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())) };
}

function appAuth(baseUrl: string, now: () => number): GitHubAppAuth {
  return new GitHubAppAuth({ clientId: 'Iv1.integration', privateKey: pem,
    repository: 'owner/repo', apiUrl: baseUrl, installationId: 123 }, { now });
}

function tokenReply(response: ServerResponse, token: string, now: number): void {
  json(response, { token, expires_at: new Date(now + 120_000).toISOString() }, 201);
}

function comment(): OutboxEntry {
  return { id: 1, jobId: 1, kind: 'comment', key: 'comment', attempts: 1,
    leaseToken: 'lease', payload: { repository: 'owner/repo', issueNumber: 42, body: 'Reply' } };
}

function reaction(): OutboxEntry {
  return { id: 2, jobId: 1, kind: 'reaction', key: 'reaction', attempts: 1,
    leaseToken: 'lease', payload: { repository: 'owner/repo', issueNumber: 42, content: 'eyes' } };
}

const signal = () => new AbortController().signal;

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for local request');
}

test('a comment refreshes after pagination and posts with the new token', async () => {
  let now = initialNow;
  let mints = 0;
  const api = await localApi((call, response) => {
    if (call.path === '/app/installations/123/access_tokens') {
      tokenReply(response, `token${++mints}`, now);
    } else if (call.method === 'GET' && call.path.endsWith('page=1')) {
      json(response, Array.from({ length: 100 }, () => ({ body: 'older' })));
    } else if (call.method === 'GET' && call.path.endsWith('page=2')) {
      now += 60_000;
      json(response, []);
    } else if (call.method === 'POST' && call.path.endsWith('/comments')) {
      json(response, { id: 1 }, 201);
    } else assert.fail(`Unexpected request: ${call.method} ${call.path}`);
  });
  try {
    const client = new GitHubClient(appAuth(api.baseUrl, () => now), api.baseUrl);
    await client.deliver(comment(), 'delivery', signal());
    const feedback = api.calls.filter(call => call.path.startsWith('/repos/'));
    assert.deepEqual(feedback.map(call => [call.method, call.authorization]), [
      ['GET', 'Bearer token1'], ['GET', 'Bearer token1'], ['POST', 'Bearer token2'],
    ]);
    assert.equal(mints, 2);
    assert.match(String((feedback[2]?.body as { body: string }).body), /Reply\n\n<!-- just-bash-agent:/);
  } finally { await api.close(); }
});

test('concurrent feedback calls share one installation token mint', async () => {
  let releaseMint!: () => void;
  const mintGate = new Promise<void>(resolve => { releaseMint = resolve; });
  let mints = 0;
  const api = await localApi((call, response) => {
    if (call.path === '/app/installations/123/access_tokens') {
      mints++;
      void mintGate.then(() => tokenReply(response, 'shared', initialNow));
    } else if (call.path.endsWith('/reactions')) {
      json(response, { id: 1 }, 201);
    } else assert.fail(`Unexpected request: ${call.method} ${call.path}`);
  });
  try {
    const client = new GitHubClient(appAuth(api.baseUrl, () => initialNow), api.baseUrl);
    const first = client.deliver(reaction(), 'first', signal());
    const second = client.deliver(reaction(), 'second', signal());
    await waitUntil(() => mints === 1);
    releaseMint();
    await Promise.all([first, second]);
    assert.equal(mints, 1);
    assert.deepEqual(api.calls.filter(call => call.path.endsWith('/reactions'))
      .map(call => call.authorization), ['Bearer shared', 'Bearer shared']);
  } finally { releaseMint(); await api.close(); }
});

test('a 401 invalidates and retries once, including when the second response is 401', async () => {
  for (const secondStatus of [201, 401]) {
    let mints = 0;
    let writes = 0;
    const api = await localApi((call, response) => {
      if (call.path === '/app/installations/123/access_tokens') {
        tokenReply(response, `token${++mints}`, initialNow);
      } else if (call.path.endsWith('/reactions')) {
        json(response, { id: writes++ }, writes === 1 ? 401 : secondStatus);
      } else assert.fail(`Unexpected request: ${call.method} ${call.path}`);
    });
    try {
      const client = new GitHubClient(appAuth(api.baseUrl, () => initialNow), api.baseUrl);
      const delivery = client.deliver(reaction(), 'delivery', signal());
      if (secondStatus === 401) await assert.rejects(delivery, /HTTP 401/);
      else await delivery;
      assert.equal(mints, 2);
      assert.equal(writes, 2);
      assert.deepEqual(api.calls.filter(call => call.path.endsWith('/reactions'))
        .map(call => call.authorization), ['Bearer token1', 'Bearer token2']);
    } finally { await api.close(); }
  }
});

test('a static token receives one 401 request without refresh', async () => {
  const api = await localApi((call, response) => {
    assert.equal(call.authorization, 'Bearer static-token');
    json(response, { message: 'unauthorized' }, 401);
  });
  try {
    const client = new GitHubClient('static-token', api.baseUrl);
    await assert.rejects(client.deliver(reaction(), 'delivery', signal()), /HTTP 401/);
    assert.equal(api.calls.length, 1);
  } finally { await api.close(); }
});

test('403 and 500 do not refresh the token or duplicate a write', async () => {
  for (const status of [403, 500]) {
    let mints = 0;
    const api = await localApi((call, response) => {
      if (call.path === '/app/installations/123/access_tokens') {
        tokenReply(response, `token${++mints}`, initialNow);
      } else if (call.path.endsWith('/reactions')) {
        json(response, { message: 'failed' }, status);
      } else assert.fail(`Unexpected request: ${call.method} ${call.path}`);
    });
    try {
      const client = new GitHubClient(appAuth(api.baseUrl, () => initialNow), api.baseUrl);
      await assert.rejects(client.deliver(reaction(), 'delivery', signal()),
        new RegExp(`HTTP ${status}`));
      assert.equal(mints, 1);
      assert.equal(api.calls.filter(call => call.path.endsWith('/reactions')).length, 1);
    } finally { await api.close(); }
  }
});

test('an aborted caller waiting on mint sends no feedback request', async () => {
  let releaseMint!: () => void;
  const mintGate = new Promise<void>(resolve => { releaseMint = resolve; });
  const api = await localApi((call, response) => {
    if (call.path === '/app/installations/123/access_tokens') {
      void mintGate.then(() => tokenReply(response, 'issued', initialNow));
    } else if (call.path.endsWith('/reactions')) {
      json(response, { id: 1 }, 201);
    } else assert.fail(`Unexpected request: ${call.method} ${call.path}`);
  });
  try {
    const client = new GitHubClient(appAuth(api.baseUrl, () => initialNow), api.baseUrl);
    const controller = new AbortController();
    const delivery = client.deliver(reaction(), 'delivery', controller.signal);
    await waitUntil(() => api.calls.some(call => call.path.endsWith('/access_tokens')));
    controller.abort();
    await assert.rejects(delivery, { name: 'AbortError' });
    releaseMint();
    await waitUntil(() => api.calls.some(call => call.path.endsWith('/access_tokens')));
    assert.equal(api.calls.filter(call => call.path.endsWith('/reactions')).length, 0);
  } finally { releaseMint(); await api.close(); }
});
