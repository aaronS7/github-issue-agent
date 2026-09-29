import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config.js';
import { GitHubClient } from './github.js';
import { ScriptedModel } from './model.js';
import { DurableQueue } from './queue.js';
import { readRecording, readRun } from './run-reader.js';
import { createWebhookServer } from './webhook.js';
import { Worker } from './worker.js';
import type { RunResult } from './workspace.js';

const exec = promisify(execFile);
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((done) => server.close(() => done()));
}

async function main() {
  const record = process.argv.includes('--record');
  const directory = await mkdtemp(join(tmpdir(), 'github-issue-demo-'));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  await writeFile(join(repository, 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  await exec('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-b', 'main', repository]);
  await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Demo', '-c', 'user.email=demo@localhost',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Demo bug'], { cwd: repository });
  const comments: { body: string }[] = [];
  const reactions: unknown[] = [];
  const github = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    if (req.method === 'POST' && req.url?.endsWith('/comments')) comments.push(payload);
    if (req.method === 'POST' && req.url?.includes('/reactions')) reactions.push(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? comments : { id: comments.length + reactions.length }));
  });
  const githubUrl = await listen(github);
  const config = loadConfig({
    GITHUB_REPOSITORY: 'demo/project', REPOSITORY_PATH: repository,
    GITHUB_WEBHOOK_SECRET: 'offline-demo-secret', GITHUB_TOKEN: 'offline-demo-token',
    GITHUB_API_URL: githubUrl, DATA_DIR: join(directory, 'data'),
    ASCIINEMA_ENABLED: String(record),
  });
  const queue = new DurableQueue(config.database, { leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
  const webhook = createWebhookServer({ queue, secret: config.webhookSecret, repositories: new Set(['demo/project']) });
  const webhookUrl = await listen(webhook);
  const worker = new Worker({ queue, config, github: new GitHubClient('offline-demo-token', githubUrl),
    createModel: (_job, event) => new ScriptedModel(event.kind === 'issue' ? [
      { script: "sed -i 's/a - b/a + b/' math.ts && cat math.ts" },
      { script: "github-comment 'I corrected the addition implementation.'" },
      { text: 'Corrected add() to use addition. Inspected the updated source; no host test runner is enabled.' },
    ] : [
      { script: "grep -q 'a + b' math.ts && printf '# Demo project\n\nadd(a, b) returns the sum.\n' > README.md" },
      { text: 'Documented add() and retained the previous fix.' },
    ]),
  });
  try {
    const issue = { number: 1, title: 'Fix addition', body: 'add(1, 2) should return 3.',
      user: { login: 'human', type: 'User' }, labels: [], html_url: 'https://github.com/demo/project/issues/1' };
    const deliver = async (event: string, deliveryId: string, data: unknown): Promise<number> => {
      const body = JSON.stringify(data);
      const response = await fetch(`${webhookUrl}/webhooks/github`, {
        method: 'POST', headers: {
          'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': deliveryId,
          'x-hub-signature-256': `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`,
        }, body,
      });
      assert.equal(response.status, 202);
      return ((await response.json()) as { jobId: number }).jobId;
    };
    const payload = { action: 'opened', issue, repository: { full_name: 'demo/project' }, sender: issue.user };
    const jobId = await deliver('issues', 'demo-issue-delivery', payload);
    assert.equal(await deliver('issues', 'demo-issue-delivery', payload), jobId);
    assert.equal(queue.listJobs().length, 1);
    await worker.processNext();
    assert.equal(queue.getJob(jobId)?.status, 'done');
    while (await worker.processNextEffect()) { /* drain durable feedback */ }
    const first = queue.getJob(jobId)!.result as RunResult;
    assert.match(await readFile(join(first.workspace, 'math.ts'), 'utf8'), /a \+ b/);
    assert.match(await readFile(first.patchPath, 'utf8'), /a \+ b/);
    const followupId = await deliver('issue_comment', 'demo-comment-delivery', {
      action: 'created', issue, repository: { full_name: 'demo/project' }, sender: issue.user,
      comment: { id: 900, body: '/agent document the addition function', user: issue.user },
    });
    await worker.processNext();
    while (await worker.processNextEffect()) { /* drain durable feedback */ }
    const followup = queue.getJob(followupId)!;
    assert.equal(followup.status, 'done');
    const result = followup.result as RunResult;
    assert.equal(result.baseCommit, first.commit);
    assert.match(await readFile(join(result.workspace, 'README.md'), 'utf8'), /returns the sum/);
    assert.match(await readFile(join(repository, 'math.ts'), 'utf8'), /a - b/);
    const observed = await readRun(config.dataDir, jobId);
    assert.equal(observed?.run?.status, 'succeeded');
    assert.ok(observed.events.some(event => event.type === 'command'));
    const recording = record ? await readRecording(config.dataDir, jobId, observed.run!.id) : null;
    if (record) {
      assert.ok(recording?.bytes.length);
      assert.equal(JSON.parse(recording.bytes.toString().split('\n')[0]!).version, 2);
    }
    const consoleEnv = join(directory, 'console.env');
    await writeFile(consoleEnv, `# Offline demo history; no GitHub or model credentials\nDATA_DIR=${config.dataDir}\nASCIINEMA_ENABLED=${record}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      demo: 'Passed — signed issue, duplicate delivery, actual just-bash edit, commit, feedback, and comment follow-up',
      externalServices: 'None; scripted model and local GitHub fixture',
      directory, database: config.database, counts: queue.stats(),
      commit: result.commit, checkout: result.workspace, patch: result.patchPath,
      githubComments: comments.length, githubReactions: reactions.length,
      recording: recording ? join(config.dataDir, 'recordings', recording.filename) : null,
      console: `npm run ui -- --env-file ${consoleEnv}`,
      view: 'Open http://127.0.0.1:3100/#runs to inspect the offline demo history',
    }, null, 2));
  } finally {
    await worker.stop();
    await Promise.all([close(webhook), close(github)]);
    queue.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
