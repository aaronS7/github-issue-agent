import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { GitHubAppAuth } from '../src/github-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const baseNow = 1_800_000_000_000;
const options = { clientId: 'Iv1.testclient', privateKey: pem, repository: 'owner/repo',
  apiUrl: 'https://github.example/api/v3' };

function tokenResponse(token: string, expiresAt: number): Response {
  return new Response(JSON.stringify({ token, expires_at: new Date(expiresAt).toISOString() }),
    { status: 201 });
}

test('signs JWT and scopes token to repository with optional feedback', async () => {
  for (const feedback of [true, false]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return calls.length === 1 ? new Response(JSON.stringify({ id: 123 }))
        : tokenResponse('ghs_test_token', baseNow + 3_600_000);
    };
    const auth = new GitHubAppAuth({ ...options, feedback }, { fetch, now: () => baseNow });
    assert.equal(await auth.getToken(), 'ghs_test_token');
    assert.equal(await auth.getToken(), 'ghs_test_token');
    assert.deepEqual(calls.map(call => `${call.init.method} ${call.url}`), [
      'GET https://github.example/api/v3/repos/owner/repo/installation',
      'POST https://github.example/api/v3/app/installations/123/access_tokens',
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { repositories: ['repo'],
      permissions: feedback ? { contents: 'read', issues: 'write' } : { contents: 'read' } });
    for (const call of calls) {
      assert.equal(call.init.redirect, 'error');
      assert.ok(call.init.signal instanceof AbortSignal);
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers.accept, 'application/vnd.github+json');
      assert.equal(headers['x-github-api-version'], '2022-11-28');
    }
    const jwt = (calls[0]?.init.headers as Record<string, string>).authorization.slice(7);
    assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, `Bearer ${jwt}`);
    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()),
      { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(claims!, 'base64url').toString()),
      { iat: Math.floor(baseNow / 1000) - 60, exp: Math.floor(baseNow / 1000) + 540,
        iss: options.clientId });
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey,
      Buffer.from(signature!, 'base64url')), true);
  }
});

test('renews near expiry and a delayed invalidation does not clear the replacement', async () => {
  let now = baseNow;
  let posts = 0;
  const fetch: typeof globalThis.fetch = async (_url, init = {}) => {
    if (init.method === 'GET') return new Response('{"id":123}');
    posts++;
    return tokenResponse(`token${posts}`, now + 120_000);
  };
  const auth = new GitHubAppAuth(options, { fetch, now: () => now });
  assert.equal(await auth.getToken(), 'token1');
  now += 59_999;
  assert.equal(await auth.getToken(), 'token1');
  now++;
  assert.equal(await auth.getToken(), 'token2');
  auth.invalidate('token1');
  assert.equal(await auth.getToken(), 'token2');
  auth.invalidate('token2');
  assert.equal(await auth.getToken(), 'token3');
  assert.equal(posts, 3);
});

test('concurrent callers share refresh, with independent caller cancellation', async () => {
  let finish!: (response: Response) => void;
  let posts = 0;
  const fetch: typeof globalThis.fetch = async (_url, init = {}) => {
    posts++;
    assert.equal(init.method, 'POST');
    return new Promise<Response>(resolve => { finish = resolve; });
  };
  const auth = new GitHubAppAuth({ ...options, installationId: 123 },
    { fetch, now: () => baseNow });
  const controller = new AbortController();
  const cancelled = auth.getToken(controller.signal);
  const surviving = auth.getToken();
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  finish(tokenResponse('shared', baseNow + 3_600_000));
  assert.equal(await surviving, 'shared');
  assert.equal(posts, 1);
});

test('rediscovers a stale automatic installation ID after a mint 404', async () => {
  const calls: string[] = [];
  let gets = 0;
  const fetch: typeof globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method} ${String(url)}`);
    if (init.method === 'GET') return new Response(JSON.stringify({ id: ++gets === 1 ? 123 : 456 }));
    if (String(url).includes('/123/')) return new Response('secret body', { status: 404 });
    return tokenResponse('replacement', baseNow + 3_600_000);
  };
  const auth = new GitHubAppAuth(options, { fetch, now: () => baseNow });
  assert.equal(await auth.getToken(), 'replacement');
  assert.deepEqual(calls.map(call => call.match(/^(GET|POST) /)?.[1]),
    ['GET', 'POST', 'GET', 'POST']);
  assert.match(calls[3]!, /installations\/456\/access_tokens$/);
});

test('failed refresh retries and never falls back to an expired token', async () => {
  let now = baseNow;
  let posts = 0;
  const fetch: typeof globalThis.fetch = async (_url, init = {}) => {
    assert.equal(init.method, 'POST');
    posts++;
    if (posts === 2) return new Response('SECRET_RESPONSE_TOKEN', { status: 403 });
    return tokenResponse(`token${posts}`, now + 120_000);
  };
  const auth = new GitHubAppAuth({ ...options, installationId: 123 }, { fetch, now: () => now });
  assert.equal(await auth.getToken(), 'token1');
  now += 120_000;
  await assert.rejects(auth.getToken(), error => {
    assert.match((error as Error).message, /HTTP 403/);
    assert.doesNotMatch((error as Error).message, /SECRET_RESPONSE_TOKEN/);
    return true;
  });
  assert.equal(await auth.getToken(), 'token3');
  assert.equal(posts, 3);
});

test('rejects malformed tokens, expiry, and installation responses', async () => {
  for (const body of [
    { token: 'two words', expires_at: new Date(baseNow + 3_600_000).toISOString() },
    { token: 'abc', expires_at: 'bad date' },
    { token: 'abc', expires_at: new Date(baseNow + 60_000).toISOString() },
    { expires_at: new Date(baseNow + 3_600_000).toISOString() },
  ]) {
    const auth = new GitHubAppAuth({ ...options, installationId: 123 }, {
      fetch: async () => new Response(JSON.stringify(body)), now: () => baseNow,
    });
    await assert.rejects(auth.getToken(), /invalid installation token response/);
  }
  const auth = new GitHubAppAuth(options, {
    fetch: async () => new Response('{"id":"123"}'), now: () => baseNow,
  });
  await assert.rejects(auth.getToken(), /invalid installation ID/);
});

test('validates configuration and sanitizes transport and JSON failures', async () => {
  for (const repository of ['owner/..', '../repo', 'owner/repo/extra', 'owner/%2e%2e']) {
    assert.throws(() => new GitHubAppAuth({ ...options, repository }), /GITHUB_REPOSITORY/);
  }
  for (const apiUrl of ['http://github.example', 'https://user:pass@github.example',
    'https://github.example/?query=secret', 'https://github.example/#fragment']) {
    assert.throws(() => new GitHubAppAuth({ ...options, apiUrl }), /HTTPS/);
  }
  assert.throws(() => new GitHubAppAuth({ ...options, clientId: ' ' }), /client ID/);
  assert.throws(() => new GitHubAppAuth({ ...options, privateKey: 'SECRET_PRIVATE_KEY' }),
    /private key/);
  assert.throws(() => new GitHubAppAuth({ ...options, installationId: 0 }), /installation ID/);
  new GitHubAppAuth({ ...options, apiUrl: 'http://127.0.0.1:1234/api/v3' });
  const auth = new GitHubAppAuth({ ...options, installationId: 123 }, {
    fetch: async () => { throw new Error('JWT_PRIVATE_KEY_SECRET_TOKEN'); }, now: () => baseNow,
  });
  await assert.rejects(auth.getToken(), error => {
    assert.equal((error as Error).message, 'GitHub App POST request failed');
    return true;
  });
  const badJson = new GitHubAppAuth({ ...options, installationId: 123 }, {
    fetch: async () => new Response('TOKEN_IN_RESPONSE'), now: () => baseNow,
  });
  await assert.rejects(badJson.getToken(), error => {
    assert.equal((error as Error).message, 'GitHub App POST returned invalid JSON');
    return true;
  });
});
