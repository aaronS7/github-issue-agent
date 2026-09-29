import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const cliArgs = ['--import', 'tsx', resolve('src/cli.ts'), 'serve'];

async function until<T>(value: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = value();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error('Timed out waiting for CLI fixture');
}

test('service uses configured App credentials for GitHub feedback without exporting an installation token',
  { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-app-auth-'));
    const keyPath = join(root, 'key.pem');
    const extensionPath = join(root, 'extensions.mjs');
    const source = join(root, 'source');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(extensionPath, `export default { createModel: () => ({
      async complete() { return { text: 'Verified App authentication.' }; }
    }) };\n`);
    execFileSync('git', ['init', '-q', source]);
    await writeFile(join(source, 'README.md'), 'Fixture\n');
    execFileSync('git', ['-C', source, 'add', 'README.md']);
    execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com',
      'commit', '-q', '-m', 'fixture']);
    const calls: { path: string; method: string; auth: string; body: unknown }[] = [];
    const api = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      calls.push({ path: request.url ?? '', method: request.method ?? '',
        auth: request.headers.authorization ?? '',
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
      let body: unknown;
      if (request.url === '/repos/owner/repo/installation') body = { id: 321 };
      else if (request.url === '/app/installations/321/access_tokens') {
        body = { token: 'fixture-app-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } else body = request.method === 'GET' ? [] : { id: 1 };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_WEBHOOK_SECRET: 'fixture-secret', GITHUB_APP_CLIENT_ID: 'Iv1.fixture',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath, GITHUB_APP_INSTALLATION_ID: '',
      GITHUB_TOKEN: 'stale-static-token', GITHUB_FEEDBACK: 'true',
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`, REPOSITORY_PATH: source,
      DATA_DIR: join(root, 'data'), EXTENSIONS: extensionPath, PORT: '0', HOST: '127.0.0.1',
      BASE_REF: 'HEAD', ISSUE_ACTIONS: 'opened',
    };
    for (const key of ['ISSUE_LABELS', 'ISSUE_AUTHORS', 'BOT_LOGINS']) delete env[key];
    const child = spawn(process.execPath, cliArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', code => done(code));
    });
    try {
      const port = await until(() => {
        for (const line of output.split('\n')) {
          try {
            const row = JSON.parse(line);
            if (row.event === 'listening') return row.address.port as number;
          } catch { /* A chunk may contain only part of a log line. */ }
        }
        if (child.exitCode !== null) throw new Error(`CLI exited: ${errors}`);
        return undefined;
      });
      const user = { login: 'alice', type: 'User' };
      const body = JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' }, sender: user,
        issue: { number: 1, title: 'Check authentication', body: 'Inspect the project.', user, labels: [],
          html_url: 'https://github.com/owner/repo/issues/1' } });
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
        method: 'POST', body, headers: { 'content-type': 'application/json',
          'x-github-event': 'issues', 'x-github-delivery': 'cli-app-fixture',
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture-secret').update(body).digest('hex')}` },
      });
      assert.equal(response.status, 202);
      await response.json();
      try {
        await until(() => calls.some(call => call.method === 'POST' && call.path.endsWith('/comments')) ? true : undefined);
      } catch {
        throw new Error(`CLI feedback did not complete: ${output}\n${errors}\n${JSON.stringify(
          calls.map(({ path, method }) => ({ path, method })))}`);
      }
      assert.equal(calls.filter(call => call.path.endsWith('/access_tokens')).length, 1);
      const minted = calls.find(call => call.path.endsWith('/access_tokens'))!;
      assert.deepEqual(minted.body, { repositories: ['repo'], permissions: { contents: 'read', issues: 'write' } });
      assert.match(minted.auth, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      for (const call of calls.filter(call => call.path.includes('/issues/'))) {
        assert.equal(call.auth, 'Bearer fixture-app-token');
      }
      child.kill('SIGTERM');
      assert.equal(await exited, 0, errors);
      assert.doesNotMatch(output + errors, /fixture-app-token|stale-static-token|BEGIN PRIVATE KEY/);
      const database = await readFile(join(root, 'data', 'queue.sqlite'));
      assert.equal(database.includes(Buffer.from('fixture-app-token')), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await new Promise<void>(done => api.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });

test('service fails clearly at startup when the App private key is unavailable or invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-app-key-'));
  try {
    const keyPath = join(root, 'key.pem');
    const extensionPath = join(root, 'extensions.mjs');
    await writeFile(extensionPath, 'export default { createModel: () => ({ complete: async () => ({ text: "done" }) }) };');
    for (const invalid of [false, true]) {
      if (invalid) await writeFile(keyPath, 'SECRET_INVALID_PRIVATE_KEY');
      await assert.rejects(execFileAsync(process.execPath, cliArgs, { env: {
        ...process.env, GITHUB_REPOSITORY: 'owner/repo', GITHUB_WEBHOOK_SECRET: 'test',
        GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        GITHUB_APP_INSTALLATION_ID: '', EXTENSIONS: extensionPath, DATA_DIR: join(root, 'data'),
      } }), error => {
        const stderr = (error as { stderr: string }).stderr;
        assert.match(stderr, invalid ? /Invalid GitHub App private key/ : /Unable to read GITHUB_APP_PRIVATE_KEY_PATH/);
        assert.doesNotMatch(stderr, /SECRET_INVALID_PRIVATE_KEY/);
        return true;
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
