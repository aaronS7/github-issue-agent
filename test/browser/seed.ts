import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { loadConfig } from '../../src/config.js';
import type { IssueEvent } from '../../src/events.js';
import { ScriptedModel } from '../../src/model.js';
import { DurableQueue } from '../../src/queue.js';
import { Worker } from '../../src/worker.js';

/** Exercise the real worker, databases and recordings without external services. */
export async function seedRuns(directory: string) {
  const source = join(directory, 'source');
  await mkdir(source);
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Browser fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: source });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(source, 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  await git('add', '.'); await git('commit', '-qm', 'Fixture');
  const config = loadConfig({ GITHUB_REPOSITORY: 'example/repository', REPOSITORY_PATH: source,
    GITHUB_WEBHOOK_SECRET: 'fixture-webhook-secret', GITHUB_TOKEN: 'fixture-token', DATA_DIR: join(directory, 'data'),
    ASCIINEMA_ENABLED: 'true', MAX_ATTEMPTS: '1' });
  const queue = new DurableQueue(config.database, { maxAttempts: 1 });
  const enqueue = (number: number, title: string) => {
    const payload: IssueEvent = { repository: 'example/repository', issueNumber: number,
      title, body: title, author: 'fixture', labels: [], action: 'opened', kind: 'issue',
      url: `https://github.com/example/repository/issues/${number}` };
    return queue.enqueue({ deliveryId: `browser-${number}`, repository: payload.repository,
      issueNumber: number, eventKind: 'issues.opened', payload });
  };
  const worker = new Worker({ queue, config, createModel: () => {
    const model = new ScriptedModel([
      { script: 'cat missing.txt', usage: { inputTokens: 30, outputTokens: 8 } },
      { script: "sed -i 's/a - b/a + b/' math.ts && cat math.ts", usage: { inputTokens: 40, outputTokens: 15 } },
      { script: "github-comment 'Addition is corrected.'" },
      { text: 'Fixed addition and inspected the updated source.' },
    ]);
    return { complete: async (messages, signal) => { await delay(180, undefined, { signal }); return model.complete(messages, signal); } };
  } });
  const failing = new Worker({ queue, config: { ...config, observability: { ...config.observability!, asciinema: false } },
    createModel: () => ({ complete: async () => { throw new Error('Fixture model is unavailable'); } }) });
  try {
    enqueue(1, 'Fix addition in math.ts'); await worker.processNext();
    enqueue(2, 'Handle a model outage'); await failing.processNext();
    enqueue(3, 'Document the addition function');
    return config.dataDir;
  } finally { await worker.stop(); await failing.stop(); queue.close(); }
}
