import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureGitHubSource } from '../src/source.js';

function records(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for fake git');
}

async function fakeGitTest(run: (fixture: { rootDir: string; log: string; release: () => void }) => Promise<void>) {
  const rootDir = mkdtempSync(join(tmpdir(), 'github-source-cancel-'));
  const bin = join(rootDir, 'bin');
  const log = join(rootDir, 'git.log');
  const releaseFile = join(rootDir, 'release');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const append = (line) => fs.appendFileSync(process.env.SOURCE_TEST_LOG, line + '\\n');
append('started');
process.on('SIGTERM', () => { append('terminated'); process.exit(0); });
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.SOURCE_TEST_RELEASE)) return;
  if (args.includes('clone')) {
    const destination = args.at(-1);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'config'), 'ok');
  }
  clearInterval(timer);
  append('completed');
  process.exit(0);
}, 5);
`, { mode: 0o755 });
  const previous = { path: process.env.PATH, log: process.env.SOURCE_TEST_LOG,
    release: process.env.SOURCE_TEST_RELEASE };
  process.env.PATH = `${bin}:${previous.path ?? ''}`;
  process.env.SOURCE_TEST_LOG = log;
  process.env.SOURCE_TEST_RELEASE = releaseFile;
  try { await run({ rootDir, log, release: () => writeFileSync(releaseFile, '') }); }
  finally {
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.log === undefined) delete process.env.SOURCE_TEST_LOG;
    else process.env.SOURCE_TEST_LOG = previous.log;
    if (previous.release === undefined) delete process.env.SOURCE_TEST_RELEASE;
    else process.env.SOURCE_TEST_RELEASE = previous.release;
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test('canceling the first caller leaves shared clone alive for the second', async () => {
  await fakeGitTest(async ({ rootDir, log, release }) => {
    const options = { repository: 'owner/repo', rootDir };
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const first = ensureGitHubSource(options, firstSignal.signal);
    const second = ensureGitHubSource(options, secondSignal.signal);
    await waitUntil(() => records(log).includes('started'));
    firstSignal.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.deepEqual(records(log), ['started']);
    release();
    const source = await second;
    assert.equal(existsSync(join(source, 'config')), true);
    assert.deepEqual(records(log), ['started', 'completed']);
  });
});

test('canceling every caller terminates clone and permits a new attempt', async () => {
  await fakeGitTest(async ({ rootDir, log, release }) => {
    const options = { repository: 'owner/repo', rootDir };
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const first = ensureGitHubSource(options, firstSignal.signal);
    const second = ensureGitHubSource(options, secondSignal.signal);
    await waitUntil(() => records(log).includes('started'));
    firstSignal.abort();
    secondSignal.abort();
    await Promise.all([
      assert.rejects(first, { name: 'AbortError' }),
      assert.rejects(second, { name: 'AbortError' }),
    ]);
    await waitUntil(() => records(log).includes('terminated'));
    const retry = ensureGitHubSource(options);
    await waitUntil(() => records(log).filter(line => line === 'started').length === 2);
    release();
    const source = await retry;
    assert.equal(existsSync(join(source, 'config')), true);
    assert.deepEqual(records(log), ['started', 'terminated', 'started', 'completed']);
  });
});

test('an already aborted caller starts no source work', async () => {
  await fakeGitTest(async ({ rootDir, log }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(ensureGitHubSource({ repository: 'owner/repo', rootDir }, controller.signal),
      { name: 'AbortError' });
    assert.deepEqual(records(log), []);
  });
});
