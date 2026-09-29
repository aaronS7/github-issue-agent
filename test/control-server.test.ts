import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlServer } from '../src/control-server.js';

test('loopback API enforces host, origin, CSRF, conflict, and serves only UI files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-control-http-'));
  const uiDir = join(directory, 'ui');
  await mkdir(uiDir);
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Console</title>');
  await writeFile(join(directory, 'outside.txt'), 'private');
  await symlink(join(directory, 'outside.txt'), join(uiDir, 'leak.txt'));
  const calls: string[] = [];
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer github-token');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const server = createControlServer({ envPath: join(directory, '.env'), uiDir, fetch: mockFetch,
    allowedOrigins: ['http://localhost:5173'] });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = await fetch(`${base}/api/config`);
    assert.equal(get.status, 200);
    const snapshot = await get.json() as { csrfToken: string; revision: string; secrets: Record<string, boolean> };
    assert.equal(snapshot.secrets.ANTHROPIC_API_KEY, false);
    const headers = { 'content-type': 'application/json', 'x-csrf-token': snapshot.csrfToken };
    const draft = { revision: snapshot.revision,
      values: { GITHUB_REPOSITORY: 'owner/repo' }, secrets: { GITHUB_TOKEN: 'github-token' } };
    assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft) })).status, 403);
    assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: { ...headers,
      origin: 'http://evil.example' }, body: JSON.stringify(draft) })).status, 403);
    const wrongHost = await new Promise<number>((done, reject) => {
      const call = request(`${base}/api/config`, { method: 'PUT', headers: { ...headers,
        host: 'evil.example' } }, (response) => { response.resume(); done(response.statusCode ?? 0); });
      call.on('error', reject);
      call.end(JSON.stringify(draft));
    });
    assert.equal(wrongHost, 403);
    const saved = await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify(draft) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.text()).includes('github-token'), false);
    assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers,
      body: JSON.stringify(draft) })).status, 409);
    const checked = await fetch(`${base}/api/github/check`, { method: 'POST', headers,
      body: JSON.stringify({ values: {}, secrets: {} }) });
    assert.deepEqual(await checked.json(), { ok: true, message: 'GitHub repository read access verified' });
    assert.deepEqual(calls, ['https://api.github.com/repos/owner/repo']);
    assert.equal((await fetch(`${base}/setup`)).status, 200);
    assert.equal((await fetch(`${base}/leak.txt`)).status, 404);
    assert.equal((await fetch(`${base}/not-a-route`)).status, 404);
    const dev = await fetch(`${base}/api/config`, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(dev.status, 200);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

test('validation and GitHub checks do not echo credentials or call invalid API URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-control-http-'));
  const uiDir = join(directory, 'ui');
  await mkdir(uiDir);
  const calls: string[] = [];
  const mockFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const server = createControlServer({ envPath: join(directory, '.env'), uiDir, fetch: mockFetch });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const snapshot = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string; revision: string };
    const headers = { 'content-type': 'application/json', 'x-csrf-token': snapshot.csrfToken };
    const validation = await fetch(`${base}/api/validate`, { method: 'POST', headers,
      body: JSON.stringify({ values: {}, secrets: {} }) });
    const result = await validation.json() as { valid: boolean; errors: Record<string, string> };
    assert.equal(result.valid, false);
    assert.equal(result.errors.GITHUB_REPOSITORY, 'Enter a repository');
    assert.equal(result.errors.MODEL_API_KEY, 'Enter a model API key');
    const extensionValidation = await fetch(`${base}/api/validate`, { method: 'POST', headers,
      body: JSON.stringify({ values: { GITHUB_REPOSITORY: 'owner/repo', EXTENSIONS: './extension.mjs' },
        secrets: { GITHUB_WEBHOOK_SECRET: 'webhook-secret', GITHUB_TOKEN: 'github-token' } }) });
    const extensionResult = await extensionValidation.json() as {
      valid: boolean; errors: Record<string, string>; warnings: Record<string, string>;
    };
    assert.equal(extensionResult.valid, true);
    assert.deepEqual(extensionResult.errors, {});
    assert.match(extensionResult.warnings.EXTENSIONS!, /createModel/);
    const malformed = await fetch(`${base}/api/config`, { method: 'PUT', headers,
      body: JSON.stringify({ revision: snapshot.revision,
        values: { CONCURRENCY: 'bad', GITHUB_API_URL: 'https://user:password@api.github.com' },
        secrets: { GITHUB_TOKEN: 'top-secret' } }) });
    assert.equal(malformed.status, 400);
    const message = await malformed.text();
    assert.equal(message.includes('top-secret'), false);
    assert.equal(message.includes('password'), false);
    const oddField = await fetch(`${base}/api/config`, { method: 'PUT', headers,
      body: `{"revision":"${snapshot.revision}","values":{"__proto__":"unexpected"},"secrets":{}}` });
    assert.equal(oddField.status, 400);
    assert.match(await oddField.text(), /Unknown field/);
    const badCheck = await fetch(`${base}/api/github/check`, { method: 'POST', headers,
      body: JSON.stringify({ values: { GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: 'http://127.0.0.2:8888' }, secrets: { GITHUB_TOKEN: 'top-secret' } }) });
    assert.equal((await badCheck.json() as { ok: boolean }).ok, false);
    assert.deepEqual(calls, []);
    const validCheck = await fetch(`${base}/api/github/check`, { method: 'POST', headers,
      body: JSON.stringify({ values: { GITHUB_REPOSITORY: 'owner/repo' },
        secrets: { GITHUB_TOKEN: 'top-secret' } }) });
    const failedText = await validCheck.text();
    assert.match(failedText, /HTTP 401/);
    assert.equal(failedText.includes('top-secret'), false);
    assert.deepEqual(calls, ['https://api.github.com/repos/owner/repo']);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

test('GitHub App check mints an installation token and reads the configured repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-control-app-'));
  const uiDir = join(directory, 'ui');
  await mkdir(uiDir);
  const keyPath = join(directory, 'app.pem');
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const calls: string[] = [];
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(url)}`);
    if (String(url).endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer installation-token');
    return Response.json({ full_name: 'owner/repo' });
  }) as typeof fetch;
  const server = createControlServer({ envPath: join(directory, '.env'), uiDir, fetch: mockFetch });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const snapshot = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string };
    const response = await fetch(`${base}/api/github/check`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': snapshot.csrfToken },
      body: JSON.stringify({ values: { GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        GITHUB_APP_INSTALLATION_ID: '123' }, secrets: {} }),
    });
    assert.deepEqual(await response.json(), { ok: true, message: 'GitHub repository read access verified' });
    assert.deepEqual(calls, [
      'POST https://api.github.com/app/installations/123/access_tokens',
      'GET https://api.github.com/repos/owner/repo',
    ]);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
