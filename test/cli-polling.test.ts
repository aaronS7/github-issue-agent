import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DurableQueue } from '../src/queue.js';

test('poll mode completes a GitHub issue without a webhook listener or secret and ignores partial relay settings',
  { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-polling-'));
    const source = join(root, 'source');
    const dataDir = join(root, 'data');
    const tracePath = join(root, 'calls.json');
    const githubToken = 'fixture-github-polling-sensitive-token';
    const relayToken = 'fixture-partial-relay-sensitive-token';
    const server = createServer((_req, res) => { res.end('occupied'); });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const port = (server.address() as AddressInfo).port;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const hookPath = join(root, 'fetch-fixture.mjs');
      const extensionPath = join(root, 'extension.mjs');
      await writeFile(extensionPath, 'export default { createModel: () => ({ complete: async () => ({ text: "Polling fixture complete" }) }) };');
      await writeFile(hookPath, `import { writeFileSync } from 'node:fs';
        const calls = [];
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(calls));
          if (url.hostname !== 'api.github.com' ||
              init?.headers?.authorization !== ${JSON.stringify(`Bearer ${githubToken}`)}) {
            throw new Error('Unexpected fixture request');
          }
          if (url.pathname === '/repos/owner/repo/issues/comments') return Response.json([]);
          if (url.pathname === '/repos/owner/repo/issues') {
            // The poller starts at process startup; this issue must be newer than its cursor.
            const timestamp = new Date(Date.now() + 1000).toISOString();
            return Response.json([{ id: 101, number: 1, state: 'open', title: 'Polling CLI fixture',
              body: 'Inspect files', user: { login: 'alice', type: 'User' }, labels: [],
              html_url: 'https://github.com/owner/repo/issues/1',
              created_at: timestamp, updated_at: timestamp }]);
          }
          throw new Error('Unexpected fixture endpoint');
        };
      `);
      execFileSync('git', ['init', '-q', source]);
      await writeFile(join(source, 'README.md'), 'Fixture\n');
      execFileSync('git', ['-C', source, 'add', 'README.md']);
      execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture']);
      const env = { ...process.env,
        GITHUB_EVENT_SOURCE: 'poll', GITHUB_REPOSITORY: 'owner/repo', GITHUB_WEBHOOK_SECRET: '',
        GITHUB_TOKEN: githubToken, GITHUB_FEEDBACK: 'false',
        GITHUB_APP_CLIENT_ID: '', GITHUB_APP_PRIVATE_KEY_PATH: '', GITHUB_APP_INSTALLATION_ID: '',
        EXTENSIONS: extensionPath, REPOSITORY_PATH: source, DATA_DIR: dataDir,
        PORT: String(port), HOST: '127.0.0.1', GITHUB_POLL_INTERVAL_MS: '15000',
        CLOUDFLARE_RELAY_URL: 'https://partial-relay.example', CLOUDFLARE_ACCOUNT_ID: '',
        CLOUDFLARE_QUEUE_ID: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_RELAY_TOKEN: relayToken,
        ISSUE_ACTIONS: 'opened', ISSUE_LABELS: '', ISSUE_AUTHORS: '', BOT_LOGINS: '', BASE_REF: 'HEAD',
      };
      child = spawn(process.execPath, ['--import', 'tsx', '--import', hookPath, resolve('src/cli.ts'), 'serve'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const exited = new Promise<number | null>((done, reject) => {
        child!.once('error', reject);
        child!.once('exit', done);
      });
      try {
        const deadline = Date.now() + 10_000;
        let complete = false;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) throw new Error(`CLI exited: ${errors}`);
          if (output.includes('"event":"polling"')) {
            const queue = new DurableQueue(join(dataDir, 'queue.sqlite'));
            try { complete = queue.listJobs().some(job => job.status === 'done'); }
            finally { queue.close(); }
            if (complete) break;
          }
          await delay(25);
        }
        assert.equal(complete, true, `No completed polling job: ${output}\n${errors}`);
        assert.match(output, /"event":"polling"/);
        assert.doesNotMatch(output, /"event":"listening"/);
        const calls = JSON.parse(await readFile(tracePath, 'utf8')) as string[];
        assert.ok(calls.includes('/repos/owner/repo/issues'));
        assert.ok(calls.includes('/repos/owner/repo/issues/comments'));
        assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'occupied');
        child.kill('SIGTERM');
        assert.equal(await exited, 0, errors);
        for (const value of [githubToken, relayToken]) assert.equal((output + errors).includes(value), false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });
