import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { matchesFilters, normalizeEvent } from './events.js';
import { GitHubClient } from './github.js';
import { GitHubAppAuth, type GitHubAuth } from './github-auth.js';
import { createConfiguredModel } from './model.js';
import { DurableQueue } from './queue.js';
import { ensureGitHubSource } from './source.js';
import { createWebhookServer } from './webhook.js';
import { Worker, type Extensions } from './worker.js';
import { readRun, readRuns } from './run-reader.js';

const usage = `Usage: node dist/cli.js COMMAND
  serve                         Start the GitHub webhook receiver and workers
  status                        Show recent jobs, feedback, and queue counts
  runs                          List jobs with attempt timing and recording availability
  inspect JOB_ID [RUN_ID]        Inspect an attempt and its first 200 timeline events
  retry JOB_ID                  Retry a dead job
  retry-outbox EFFECT_ID         Retry dead GitHub feedback without rerunning code
  replay EVENT DELIVERY_ID FILE  Ingest a saved GitHub JSON payload locally
  backup DESTINATION            Create a consistent SQLite backup (new file)

Configuration is read from environment variables; see .env.example.
status, runs, inspect, retry, retry-outbox and backup only require DATA_DIR.
`;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function modelFromEnvironment() {
  const provider = process.env.MODEL_PROVIDER ?? 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai-compatible') throw new Error('Invalid MODEL_PROVIDER');
  const apiKey = process.env.MODEL_API_KEY ?? (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined);
  if (provider === 'anthropic' && !apiKey) throw new Error('Set MODEL_API_KEY or ANTHROPIC_API_KEY');
  return createConfiguredModel({
    provider, model: required(process.env.MODEL, 'MODEL'),
    ...(apiKey ? { apiKey } : {}),
    ...(process.env.MODEL_BASE_URL ? { baseUrl: process.env.MODEL_BASE_URL } : {}),
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(usage); return; }
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  if (command === 'runs') {
    console.log(JSON.stringify(await readRuns(dataDir), null, 2));
    return;
  }
  if (command === 'inspect') {
    const result = await readRun(dataDir, Number(args[0]), args[1]);
    if (!result) throw new Error('Run not found');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (['status', 'retry', 'retry-outbox', 'backup'].includes(command)) {
    const queue = new DurableQueue(resolve(dataDir, 'queue.sqlite'));
    try {
      if (command === 'status') {
        console.log(JSON.stringify({ counts: queue.stats(), jobs: queue.listJobs(), outbox: queue.listOutbox() }, null, 2));
      } else if (command === 'backup') {
        const destination = resolve(required(args[0], 'backup destination'));
        await queue.backup(destination);
        console.log(JSON.stringify({ backup: destination }));
      } else {
        const id = Number(args[0]);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Supply a positive ID');
        const retried = command === 'retry' ? queue.retryJob(id) : queue.retryOutbox(id);
        if (!retried) throw new Error('No dead entry with that ID');
        console.log(JSON.stringify({ retried: id }));
      }
    } finally { queue.close(); }
    return;
  }
  if (command !== 'serve' && command !== 'replay') throw new Error(usage);
  const config = loadConfig();
  const queue = new DurableQueue(config.database, { leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
  try {
    if (command === 'replay') {
      const [eventName, deliveryId, file] = args;
      if (!eventName || !deliveryId || !file) throw new Error(usage);
      const event = normalizeEvent(eventName, JSON.parse(await readFile(file, 'utf8')), config.filters);
      if (!event || !config.repositories[event.repository.toLowerCase()] || !matchesFilters(event, config.filters)) {
        console.log(JSON.stringify({ ignored: true }));
        return;
      }
      const jobId = queue.enqueue({
        deliveryId, repository: event.repository.toLowerCase(), issueNumber: event.issueNumber,
        eventKind: event.kind, payload: event,
      });
      console.log(JSON.stringify({ jobId }));
      return;
    }
    const extensions: Extensions = config.extensionPath
      ? (await import(pathToFileURL(config.extensionPath).href)).default : {};
    if (!extensions || typeof extensions !== 'object') throw new Error('Extension module must export an object as default');
    // Fail startup on missing model configuration rather than exhausting queued jobs.
    const model = extensions.createModel ? undefined : modelFromEnvironment();
    const createModel = extensions.createModel ?? (() => model!);
    let githubAuth: GitHubAuth | undefined = config.githubToken;
    if (config.githubApp) {
      let privateKey: string;
      try { privateKey = await readFile(config.githubApp.privateKeyPath, 'utf8'); }
      catch { throw new Error('Unable to read GITHUB_APP_PRIVATE_KEY_PATH'); }
      githubAuth = new GitHubAppAuth({
        ...config.githubApp, privateKey, repository: Object.keys(config.repositories)[0]!,
        apiUrl: config.githubApiUrl, feedback: config.feedback,
      });
    }
    const worker = new Worker({
      queue, config, createModel, extensions,
      ...(githubAuth ? { github: new GitHubClient(githubAuth, config.githubApiUrl) } : {}),
      resolveSource: async (repository, signal) => config.repositories[repository]?.path ?? ensureGitHubSource({
        repository, rootDir: config.dataDir, serverUrl: config.githubServerUrl,
        ...(githubAuth ? { auth: githubAuth } : {}),
      }, signal),
      log: (event) => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })),
    });
    const server = createWebhookServer({ queue, secret: config.webhookSecret,
      repositories: new Set(Object.keys(config.repositories)), filters: config.filters });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, done);
    });
    worker.start();
    console.log(JSON.stringify({ event: 'listening', address: server.address(), database: config.database }));
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    const closed = new Promise<void>((done) => server.close(() => done()));
    await worker.stop();
    await closed;
  } finally { queue.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
