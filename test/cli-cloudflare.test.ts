import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DurableQueue } from '../src/queue.js';

test('serve activates the configured relay, completes a local job, and stops cleanly without logging relay secrets',
  { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-cloudflare-'));
    const source = join(root, 'source');
    const dataDir = join(root, 'data');
    const secret = 'fixture-webhook-signing-value';
    const apiToken = 'fixture-cloudflare-api-sensitive-value';
    const relayToken = 'fixture-relay-sensitive-value-with-32-characters';
    const tracePath = join(root, 'calls.json');
    const user = { login: 'alice', type: 'User' };
    const raw = JSON.stringify({ action: 'opened', sender: user, repository: { full_name: 'owner/repo' },
      issue: { number: 1, title: 'Relay CLI fixture', body: 'Inspect files', user, labels: [],
        html_url: 'https://github.com/owner/repo/issues/1' } });
    const hash = createHash('sha256').update(raw).digest('hex');
    const pointer = { version: 1, deliveryId: 'cli-relay-fixture', eventName: 'issues', bodySha256: hash,
      objectKey: `github/cli-relay-fixture/${hash}`,
      signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` };
    const hookPath = join(root, 'fetch-fixture.mjs');
    const extensionPath = join(root, 'extension.mjs');
    await writeFile(extensionPath, 'export default { createModel: () => ({ complete: async () => ({ text: "Relay fixture complete" }) }) };');
    await writeFile(hookPath, `import { writeFileSync } from 'node:fs';
      const calls = [];
      let acked = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(calls));
        if (url.hostname === 'api.cloudflare.com') {
          if (init.headers.authorization !== ${JSON.stringify(`Bearer ${apiToken}`)}) throw new Error('Wrong fixture API credential');
          if (url.pathname.endsWith('/pull')) return Response.json({ success: true, result: { messages: acked ? [] : [{
            lease_id: 'private-fixture-lease', metadata: { 'CF-Content-Type': 'json' },
            body: ${JSON.stringify(Buffer.from(JSON.stringify(pointer)).toString('base64'))}
          }] } });
          if (url.pathname.endsWith('/ack')) { acked = true; return Response.json({ success: true, result: { ackCount: 1 } }); }
        }
        if (url.hostname === 'relay.example' && url.pathname.startsWith('/payload/')) {
          if (init.headers.authorization !== ${JSON.stringify(`Bearer ${relayToken}`)}) throw new Error('Wrong fixture relay credential');
          return new Response(${JSON.stringify(raw)});
        }
        throw new Error('Unexpected fixture request');
      };
    `);
    execFileSync('git', ['init', '-q', source]);
    await writeFile(join(source, 'README.md'), 'Fixture\n');
    execFileSync('git', ['-C', source, 'add', 'README.md']);
    execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture']);
    const env = { ...process.env, GITHUB_EVENT_SOURCE: 'webhook',
      GITHUB_REPOSITORY: 'owner/repo', GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_FEEDBACK: 'false', GITHUB_APP_CLIENT_ID: '', GITHUB_APP_PRIVATE_KEY_PATH: '', GITHUB_APP_INSTALLATION_ID: '',
      EXTENSIONS: extensionPath, REPOSITORY_PATH: source, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1',
      CLOUDFLARE_RELAY_URL: 'https://relay.example', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_QUEUE_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_RELAY_TOKEN: relayToken, CLOUDFLARE_POLL_INTERVAL_MS: '1000',
      ISSUE_ACTIONS: 'opened', ISSUE_LABELS: '', ISSUE_AUTHORS: 'alice', BOT_LOGINS: '', BASE_REF: 'HEAD',
    };
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', hookPath, resolve('src/cli.ts'), 'serve'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
    try {
      const deadline = Date.now() + 10_000;
      let complete = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`CLI exited: ${errors}`);
        if (output.includes('"event":"listening"')) {
          const queue = new DurableQueue(join(dataDir, 'queue.sqlite'));
          try { complete = queue.listJobs().some(job => job.status === 'done'); } finally { queue.close(); }
          if (complete) break;
        }
        await delay(25);
      }
      assert.equal(complete, true, `No completed relay job: ${output}\n${errors}`);
      const calls = JSON.parse(await readFile(tracePath, 'utf8')) as string[];
      assert.ok(calls.some(path => path.endsWith('/ack')));
      child.kill('SIGTERM');
      assert.equal(await exited, 0, errors);
      for (const value of [apiToken, relayToken, secret]) assert.equal((output + errors).includes(value), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });
