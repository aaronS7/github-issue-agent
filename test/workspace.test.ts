import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { finalizeWorkspace, prepareWorkspace, readRunResult } from '../src/workspace.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-workspace-'));
  const sourcePath = join(dir, 'source');
  const rootDir = join(dir, 'state');
  mkdirSync(sourcePath);
  git(sourcePath, ['init', '-b', 'main']);
  git(sourcePath, ['config', 'user.name', 'Test']);
  git(sourcePath, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(sourcePath, 'keep.txt'), 'original\n');
  writeFileSync(join(sourcePath, 'remove.txt'), 'remove me\n');
  git(sourcePath, ['add', '--all']);
  git(sourcePath, ['commit', '-m', 'base']);
  return { dir, sourcePath, rootDir, base: git(sourcePath, ['rev-parse', 'HEAD']),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('private checkout captures edits, new files, deletions, patch and durable result', async () => {
  const f = fixture();
  try {
    const workspace = await prepareWorkspace({ sourcePath: f.sourcePath, baseRef: 'main',
      rootDir: f.rootDir, jobId: 1, attempt: 1, leaseToken: 'lease-1' });
    assert.equal(workspace.baseCommit, f.base);
    assert.equal(existsSync(join(workspace.path, '.git')), false);
    assert.equal(existsSync(workspace.gitDir), true);
    writeFileSync(join(workspace.path, 'keep.txt'), 'changed\n');
    writeFileSync(join(workspace.path, 'added.txt'), 'new\n');
    rmSync(join(workspace.path, 'remove.txt'));
    const result = await finalizeWorkspace(workspace, { summary: 'Applied issue', assertActive: () => true });
    assert.equal(result.changed, true);
    assert.notEqual(result.commit, f.base);
    assert.deepEqual(readRunResult(workspace.resultPath), result);
    const patch = readFileSync(result.patchPath, 'utf8');
    assert.match(patch, /added\.txt/);
    assert.match(patch, /remove\.txt/);
    assert.match(patch, /keep\.txt/);
    assert.equal(readFileSync(join(f.sourcePath, 'keep.txt'), 'utf8'), 'original\n');
    assert.equal(git(f.sourcePath, ['rev-parse', 'HEAD']), f.base);
  } finally { f.cleanup(); }
});

test('a followup starts from prior committed result and no-change run keeps its commit', async () => {
  const f = fixture();
  try {
    const first = await prepareWorkspace({ sourcePath: f.sourcePath, baseRef: 'main',
      rootDir: f.rootDir, jobId: 1, attempt: 1, leaseToken: 'lease-1' });
    writeFileSync(join(first.path, 'first.txt'), 'first\n');
    const result = await finalizeWorkspace(first, { summary: 'First', assertActive: () => true });
    const second = await prepareWorkspace({ sourcePath: f.sourcePath, baseRef: 'main',
      rootDir: f.rootDir, jobId: 2, attempt: 1, leaseToken: 'lease-2', previousResult: result });
    assert.equal(readFileSync(join(second.path, 'first.txt'), 'utf8'), 'first\n');
    assert.equal(second.baseCommit, result.commit);
    const noChange = await finalizeWorkspace(second, { summary: 'Nothing to change', assertActive: () => true });
    assert.equal(noChange.changed, false);
    assert.equal(noChange.commit, result.commit);
    assert.equal(readFileSync(noChange.patchPath, 'utf8'), '');
  } finally { f.cleanup(); }
});

test('lost lease and unexpected Git metadata stop result publication', async () => {
  const f = fixture();
  try {
    const workspace = await prepareWorkspace({ sourcePath: f.sourcePath, baseRef: 'main',
      rootDir: f.rootDir, jobId: 1, attempt: 1, leaseToken: 'lease-1' });
    await assert.rejects(finalizeWorkspace(workspace, { summary: 'Stopped', assertActive: () => false }),
      /lease is no longer active/);
    assert.equal(existsSync(workspace.resultPath), false);
    writeFileSync(join(workspace.path, '.git'), 'surprise');
    await assert.rejects(finalizeWorkspace(workspace, { summary: 'Stopped', assertActive: () => true }),
      /unexpected \.git/);
    assert.equal(existsSync(workspace.resultPath), false);
  } finally { f.cleanup(); }
});
