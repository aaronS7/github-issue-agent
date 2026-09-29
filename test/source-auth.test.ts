import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GitHubTokenProvider } from '../src/github-auth.js';
import { ensureGitHubSource } from '../src/source.js';

function fixture(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'source-auth-'));
  const bin = join(root, 'bin');
  const log = join(root, 'calls.json');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const mode = ${JSON.stringify(mode)};
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
const header = process.env.GIT_CONFIG_VALUE_0;
const auth = header ? Buffer.from(header.split(' ').at(-1), 'base64').toString() : '';
calls.push({ args, auth });
fs.writeFileSync(log, JSON.stringify(calls));
const cloning = args.includes('clone');
const destination = args.at(-1);
if (mode === 'always' || (mode === 'once' && calls.length === 1) || mode === 'other') {
  if (cloning) fs.mkdirSync(destination, { recursive: true });
  process.stderr.write((mode === 'other' ? 'network failed' : 'fatal: Authentication failed') + ' ' + header);
  process.exit(128);
}
if (cloning) {
  if (fs.existsSync(destination)) { process.stderr.write('partial clone was not removed'); process.exit(55); }
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'config'), '[remote "origin"]\\n url = ' + args.at(-2) + '\\n');
}
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  let generation = 1;
  let acquisitions = 0;
  const invalidated: string[] = [];
  const auth: GitHubTokenProvider = {
    async getToken(signal) {
      signal?.throwIfAborted();
      acquisitions++;
      return `fake-token-${generation}`;
    },
    invalidate(token) { invalidated.push(token); generation++; },
  };
  return {
    root, auth, invalidated,
    acquisitions: () => acquisitions,
    expire: () => generation++,
    calls: () => JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; auth: string }[],
    close() {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('managed Git source acquires current credentials for both clone and fetch', async () => {
  const f = fixture();
  try {
    const options = { repository: 'owner/repo', rootDir: f.root, auth: f.auth };
    const source = await ensureGitHubSource(options);
    f.expire();
    assert.equal(await ensureGitHubSource(options), source);
    assert.equal(f.acquisitions(), 2);
    assert.deepEqual(f.calls().map(call => call.auth), ['x-access-token:fake-token-1', 'x-access-token:fake-token-2']);
    assert.equal(existsSync(join(source, 'config')), true);
    assert.doesNotMatch(readFileSync(join(source, 'config'), 'utf8'), /fake-token/);
    for (const call of f.calls()) assert.doesNotMatch(call.args.join(' '), /fake-token/);
  } finally { f.close(); }
});

test('Git retries an authentication rejection once with fresh credentials and a clean temporary clone', async () => {
  const f = fixture('once');
  try {
    const source = await ensureGitHubSource({ repository: 'owner/repo', rootDir: f.root, auth: f.auth });
    assert.equal(existsSync(join(source, 'config')), true);
    assert.equal(f.calls().length, 2);
    assert.deepEqual(f.invalidated, ['fake-token-1']);
    assert.deepEqual(f.calls().map(call => call.auth), ['x-access-token:fake-token-1', 'x-access-token:fake-token-2']);
  } finally { f.close(); }
});

test('Git auth retries are bounded and unrelated failures do not refresh or expose secrets', async () => {
  for (const mode of ['always', 'other']) {
    const f = fixture(mode);
    try {
      await assert.rejects(ensureGitHubSource({ repository: 'owner/repo', rootDir: f.root, auth: f.auth }),
        error => {
          assert.match((error as Error).message, /GitHub repository clone failed/);
          assert.doesNotMatch((error as Error).message, /fake-token|AUTHORIZATION|basic/);
          return true;
        });
      assert.equal(f.calls().length, mode === 'always' ? 2 : 1);
      assert.equal(f.invalidated.length, mode === 'always' ? 2 : 0);
    } finally { f.close(); }
  }
});
