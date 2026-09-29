import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlServer } from '../src/control-server.js';

const publicUrl = 'https://console.tailnet.example:8443';
const publicHost = 'console.tailnet.example:8443';

async function fixture(configurePublic = true) {
  const directory = mkdtempSync(join(tmpdir(), 'issue-control-origin-'));
  const server = createControlServer({ envPath: join(directory, '.env'),
    ...(configurePublic ? { publicUrl } : {}) });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const send = async (path: string, options: {
    method?: string; host?: string; origin?: string; headers?: Record<string, string>; body?: string;
  } = {}) => new Promise<{ status: number; body: string }>((done, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}`,
      ...options.headers };
    if (options.origin !== undefined) headers.origin = options.origin;
    const req = request(`http://127.0.0.1:${port}${path}`, { method: options.method ?? 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
  const cleanup = async () => {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  };
  return { port, send, cleanup };
}

test('configured HTTPS Host and matching Origin allow GET and CSRF-protected PUT', async () => {
  const f = await fixture();
  try {
    const config = await f.send('/api/config', { host: publicHost, origin: publicUrl });
    assert.equal(config.status, 200);
    const snapshot = JSON.parse(config.body) as { csrfToken: string; revision: string };
    const body = JSON.stringify({ revision: snapshot.revision,
      values: { GITHUB_REPOSITORY: 'owner/repo' }, secrets: {} });
    const withoutCsrf = await f.send('/api/config', { method: 'PUT', host: publicHost,
      origin: publicUrl, headers: { 'content-type': 'application/json' }, body });
    assert.equal(withoutCsrf.status, 403);
    const saved = await f.send('/api/config', { method: 'PUT', host: publicHost,
      origin: publicUrl, headers: { 'content-type': 'application/json',
        'x-csrf-token': snapshot.csrfToken }, body });
    assert.equal(saved.status, 200);
    assert.equal((JSON.parse(saved.body) as { values: { GITHUB_REPOSITORY: string } })
      .values.GITHUB_REPOSITORY, 'owner/repo');
  } finally { await f.cleanup(); }
});

test('public access requires the exact configured host and HTTPS origin', async () => {
  const f = await fixture();
  try {
    const denied = [
      { host: publicHost, origin: 'http://console.tailnet.example:8443' },
      { host: publicHost, origin: 'https://console.tailnet.example' },
      { host: publicHost, origin: 'https://other.tailnet.example:8443' },
      { host: 'console.tailnet.example', origin: publicUrl },
      { host: 'other.tailnet.example:8443', origin: publicUrl },
      { host: 'console.tailnet.example:443', origin: publicUrl },
      { host: 'console.tailnet.example:8443:80', origin: publicUrl },
      { host: 'console%2etailnet.example:8443', origin: publicUrl },
      { host: 'user@console.tailnet.example:8443', origin: publicUrl },
      { host: 'console.tailnet.example:8443/path', origin: publicUrl },
    ];
    for (const input of denied) {
      const response = await f.send('/api/config', input);
      assert.equal(response.status, 403, JSON.stringify(input));
    }
    const spoofed = await f.send('/api/config', { host: 'other.tailnet.example:8443',
      origin: publicUrl, headers: { 'x-forwarded-host': publicHost,
        'x-forwarded-proto': 'https', forwarded: `host=${publicHost};proto=https` } });
    assert.equal(spoofed.status, 403);
  } finally { await f.cleanup(); }
});

test('invalid public URLs fail before listening', () => {
  const invalid = [
    'http://console.tailnet.example:8443',
    'https://user:pass@console.tailnet.example:8443',
    'https://console.tailnet.example:8443/console',
    'https://console.tailnet.example:8443?mode=ui',
    'https://console.tailnet.example:8443#ui',
    'https://*.tailnet.example:8443',
  ];
  for (const value of invalid) {
    assert.throws(() => createControlServer({ publicUrl: value }), undefined, value);
  }
});

test('default server keeps loopback origin policy and ignores forwarded headers', async () => {
  const f = await fixture(false);
  try {
    const loopback = `http://127.0.0.1:${f.port}`;
    assert.equal((await f.send('/api/config', { origin: loopback })).status, 200);
    assert.equal((await f.send('/api/config', { host: `localhost:${f.port}`,
      origin: `http://localhost:${f.port}` })).status, 200);
    assert.equal((await f.send('/api/config', { host: publicHost, origin: publicUrl,
      headers: { 'x-forwarded-host': `127.0.0.1:${f.port}`, 'x-forwarded-proto': 'http' } })).status, 403);
    assert.equal((await f.send('/api/config', { origin: publicUrl })).status, 403);
  } finally { await f.cleanup(); }
});
