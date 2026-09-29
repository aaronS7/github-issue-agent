import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureGitHubSource } from '../src/source.js';

test('managed source clones once, refreshes, and never puts credentials in args or config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-source-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const header = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:test-secret').toString('base64');
fs.appendFileSync(process.env.SOURCE_LOG, JSON.stringify({
  args, authMatches: process.env.GIT_CONFIG_VALUE_0 === header,
  key: process.env.GIT_CONFIG_KEY_0,
  noSystem: process.env.GIT_CONFIG_NOSYSTEM,
  noGlobal: process.env.GIT_CONFIG_GLOBAL,
}) + '\\n');
if (args.includes('clone')) {
  const destination = args.at(-1);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'config'), '[remote "origin"]\\n url = ' + args.at(-2) + '\\n');
}
if (args.includes('fetch')) {
  const gitDir = args.find(arg => arg.startsWith('--git-dir=')).slice('--git-dir='.length);
  fs.writeFileSync(path.join(gitDir, 'fetched'), 'yes');
}
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldLog = process.env.SOURCE_LOG;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.SOURCE_LOG = log;
  try {
    const options = { repository: 'Owner/Repo', rootDir: dir, token: 'test-secret' };
    const [first, concurrent] = await Promise.all([
      ensureGitHubSource(options), ensureGitHubSource(options),
    ]);
    assert.equal(first, concurrent);
    assert.equal(existsSync(join(first, 'config')), true);
    await ensureGitHubSource(options);
    assert.equal(readFileSync(join(first, 'fetched'), 'utf8'), 'yes');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      args: string[]; authMatches: boolean; key: string; noSystem: string; noGlobal: string;
    });
    assert.equal(calls.length, 2);
    assert.equal(calls.filter(call => call.args.includes('clone')).length, 1);
    assert.equal(calls.filter(call => call.args.includes('fetch')).length, 1);
    for (const call of calls) {
      assert.equal(call.authMatches, true);
      assert.equal(call.key, 'http.https://github.com/.extraheader');
      assert.equal(call.noSystem, '1');
      assert.equal(call.noGlobal, '/dev/null');
      assert.equal(call.args.join(' ').includes('test-secret'), false);
      assert.equal(call.args.join(' ').includes(Buffer.from('x-access-token:test-secret').toString('base64')), false);
    }
    assert.match(readFileSync(join(first, 'config'), 'utf8'), /https:\/\/github\.com\/Owner\/Repo\.git/);
    assert.equal(readFileSync(join(first, 'config'), 'utf8').includes('test-secret'), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.SOURCE_LOG; else process.env.SOURCE_LOG = oldLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repository and server URL validation reject unsafe inputs', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'github-source-invalid-'));
  try {
    for (const repository of ['owner', '../repo', 'owner/../repo', 'owner/repo?x=1', 'owner/repo name']) {
      await assert.rejects(ensureGitHubSource({ repository, rootDir }), /Repository must be owner\/name/);
    }
    await assert.rejects(ensureGitHubSource({ repository: 'owner/repo', rootDir,
      serverUrl: 'http://example.com' }), /must be HTTPS/);
    await assert.rejects(ensureGitHubSource({ repository: 'owner/repo', rootDir,
      serverUrl: 'https://token@example.com' }), /must be HTTPS/);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
