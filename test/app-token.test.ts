import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { mintInstallationToken } from '../examples/mint-installation-token.mjs';

const execFileAsync = promisify(execFile);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const now = 1_800_000_000_000;
const expiresAt = '2027-01-15T12:00:00Z';

test('signs RS256 JWT and asks GitHub for a repository- and permission-scoped token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = calls.length === 1 ? { id: 123 } : { token: 'ghs_test_token', expires_at: expiresAt };
    return new Response(JSON.stringify(body), { status: calls.length === 1 ? 200 : 201,
      headers: { 'content-type': 'application/json' } });
  };
  const result = await mintInstallationToken({
    clientId: 'Iv1.testclient', privateKey: pem, repository: 'owner/repo',
    apiUrl: 'https://github.example/api/v3',
  }, { fetch, now: () => now });
  assert.deepEqual(result, { token: 'ghs_test_token', expiresAt, installationId: 123 });
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url}`), [
    'GET https://github.example/api/v3/repos/owner/repo/installation',
    'POST https://github.example/api/v3/app/installations/123/access_tokens',
  ]);
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    repositories: ['repo'], permissions: { contents: 'read', issues: 'write' },
  });
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['x-github-api-version'], '2022-11-28');
    assert.equal(headers.accept, 'application/vnd.github+json');
  }
  const auth = (calls[0]?.init.headers as Record<string, string>).authorization;
  assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, auth);
  assert.match(auth, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const jwt = auth.slice('Bearer '.length);
  const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString()), {
    iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: 'Iv1.testclient',
  });
  assert.equal(verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey,
    Buffer.from(encodedSignature!, 'base64url')), true);
});

test('validates inputs before requesting and keeps response secrets out of errors', async () => {
  let requests = 0;
  const fetch = async () => { requests++; return new Response('{}'); };
  for (const repository of ['owner/..', '../repo', 'owner/repo/extra', 'owner/%2e%2e']) {
    await assert.rejects(mintInstallationToken({ clientId: 'client', privateKey: pem, repository },
      { fetch, now: () => now }), /GITHUB_REPOSITORY/);
  }
  await assert.rejects(mintInstallationToken({ clientId: 'client', privateKey: pem,
    repository: 'owner/repo', apiUrl: 'http://github.example' }, { fetch, now: () => now }), /HTTPS/);
  await assert.rejects(mintInstallationToken({ clientId: 'client', privateKey: 'SECRET_PRIVATE_KEY',
    repository: 'owner/repo' }, { fetch, now: () => now }), /Invalid GitHub App private key/);
  assert.equal(requests, 0);

  const fail = async () => new Response('SERVER_BODY_WITH_SECRET_TOKEN', { status: 403 });
  await assert.rejects(mintInstallationToken({ clientId: 'client', privateKey: pem,
    repository: 'owner/repo' }, { fetch: fail, now: () => now }), (error: Error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /SERVER_BODY_WITH_SECRET_TOKEN|Bearer|PRIVATE_KEY/);
      return true;
    });
  await assert.rejects(mintInstallationToken({ clientId: 'client', privateKey: pem,
    repository: 'owner/repo' }, { fetch: async () => { throw new Error('JWT_AND_KEY_IN_TRANSPORT_ERROR'); },
    now: () => now }), (error: Error) => {
      assert.equal(error.message, 'GitHub App GET request failed');
      return true;
    });
});

test('CLI prints only the token on stdout and metadata on stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'issue-app-token-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const preloadPath = join(dir, 'fake-fetch.mjs');
    await writeFile(keyPath, pem);
    await writeFile(preloadPath, `globalThis.fetch = async (url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ id: 123 }), { status: 200 });
      return new Response(JSON.stringify({ token: 'ghs_cli_token', expires_at: '${expiresAt}' }), { status: 201 });
    };\n`);
    const { stdout, stderr } = await execFileAsync(process.execPath,
      [`--import=${preloadPath}`, resolve('examples/mint-installation-token.mjs')], {
        env: { ...process.env, GITHUB_APP_CLIENT_ID: 'Iv1.testclient',
          GITHUB_APP_PRIVATE_KEY_PATH: keyPath, GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_API_URL: 'https://github.example/api/v3' },
      });
    assert.equal(stdout, 'ghs_cli_token\n');
    assert.match(stderr, /Installation 123; token expires 2027-01-15T12:00:00Z/);
    assert.doesNotMatch(stderr, /ghs_cli_token|Bearer|PRIVATE KEY/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
