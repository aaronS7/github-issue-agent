import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export interface PreviousResult {
  gitDir: string;
  commit: string;
}

export interface PrepareWorkspaceOptions {
  sourcePath: string;
  baseRef: string;
  rootDir: string;
  jobId: number;
  attempt: number;
  leaseToken: string;
  previousResult?: PreviousResult;
}

export interface Workspace {
  path: string;
  gitDir: string;
  baseCommit: string;
  artifactDir: string;
  resultPath: string;
}

export interface RunResult {
  workspace: string;
  gitDir: string;
  baseCommit: string;
  commit: string;
  patchPath: string;
  summary: string;
  changed: boolean;
}

export interface FinalizeWorkspaceOptions {
  summary: string;
  assertActive: () => boolean | Promise<boolean>;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && key !== 'SSH_ASKPASS' && key !== 'GIT_ASKPASS'));
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Issue Agent',
    GIT_AUTHOR_EMAIL: 'issue-agent@localhost',
    GIT_COMMITTER_NAME: 'Issue Agent',
    GIT_COMMITTER_EMAIL: 'issue-agent@localhost',
  };
}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsync=committed',
    ...args,
  ], { cwd, env: gitEnvironment(), signal, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

function inWorkspace(workspace: Workspace, args: string[]): string[] {
  return [`--git-dir=${workspace.gitDir}`, `--work-tree=${workspace.path}`, ...args];
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableJson(path: string, data: unknown): void {
  const directory = resolve(path, '..');
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `.result-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    syncFile(temp);
    renameSync(temp, path);
    syncDirectory(directory);
  } finally {
    if (existsSync(temp)) rmSync(temp);
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid lease token');
  return value;
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Prepare a private clone. Only `path` is handed to the command agent. */
export async function prepareWorkspace(options: PrepareWorkspaceOptions, signal?: AbortSignal): Promise<Workspace> {
  const { sourcePath, baseRef, rootDir, jobId, attempt, leaseToken, previousResult } = options;
  if (!Number.isSafeInteger(jobId) || jobId < 1 || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('Invalid job or attempt');
  }
  const source = realpathSync(previousResult?.gitDir ?? sourcePath);
  const attemptDir = join(resolve(rootDir), 'runs', String(jobId),
    `attempt-${attempt}-${safeSegment(leaseToken)}`);
  const checkout = join(attemptDir, 'checkout');
  const gitDir = join(attemptDir, 'git');
  const artifactDir = join(attemptDir, 'artifacts');
  const templateDir = join(attemptDir, 'template');
  const resultPath = join(artifactDir, 'result.json');
  if (existsSync(attemptDir)) throw new Error(`Attempt workspace already exists: ${attemptDir}`);
  mkdirSync(templateDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  await git(['clone', '--no-local', `--template=${templateDir}`, `--separate-git-dir=${gitDir}`,
    '--', source, checkout], attemptDir, signal);
  const workspace: Workspace = { path: checkout, gitDir, baseCommit: '', artifactDir, resultPath };
  const targetRef = previousResult?.commit ?? baseRef;
  if (previousResult && !/^[0-9a-f]{40,64}$/i.test(targetRef)) {
    throw new TypeError('Previous commit must be a full Git object ID');
  }
  const baseCommit = await git(inWorkspace(workspace,
    ['rev-parse', '--verify', '--end-of-options', `${targetRef}^{commit}`]), checkout, signal);
  await git(inWorkspace(workspace, ['checkout', '--detach', '--force', baseCommit]), checkout, signal);
  const pointer = join(checkout, '.git');
  if (!entryExists(pointer)) throw new Error('Clone did not create a Git pointer');
  rmSync(pointer);
  workspace.baseCommit = baseCommit;
  return workspace;
}

/** Commit all changed files, write a binary patch, then durably publish result.json. */
export async function finalizeWorkspace(workspace: Workspace, options: FinalizeWorkspaceOptions,
                                        signal?: AbortSignal): Promise<RunResult> {
  if (typeof options.summary !== 'string') throw new TypeError('Summary must be a string');
  const assertActive = async () => {
    if (!await options.assertActive()) throw new Error('Workspace lease is no longer active');
  };
  await assertActive();
  const pointer = join(workspace.path, '.git');
  if (entryExists(pointer)) {
    throw new Error('Agent workspace contains an unexpected .git entry');
  }
  await git(inWorkspace(workspace, ['add', '--all']), workspace.path, signal);
  const staged = await git(inWorkspace(workspace, ['diff', '--cached', '--name-only', '-z']), workspace.path, signal);
  const changed = staged.length > 0;
  if (changed) {
    await git(inWorkspace(workspace, ['commit', '-m', 'Apply GitHub issue agent changes']), workspace.path, signal);
  }
  const commit = await git(inWorkspace(workspace, ['rev-parse', 'HEAD']), workspace.path, signal);
  await git(inWorkspace(workspace, ['update-ref', 'refs/heads/issue-agent-result', commit]), workspace.path, signal);
  const patchPath = join(workspace.artifactDir, 'changes.patch');
  const temporaryPatch = join(workspace.artifactDir, `.changes-${randomUUID()}.tmp`);
  try {
    await git(inWorkspace(workspace,
      ['diff', '--binary', `--output=${temporaryPatch}`, workspace.baseCommit, commit]), workspace.path, signal);
    syncFile(temporaryPatch);
    renameSync(temporaryPatch, patchPath);
    syncDirectory(workspace.artifactDir);
  } finally {
    if (existsSync(temporaryPatch)) rmSync(temporaryPatch);
  }
  const result: RunResult = {
    workspace: workspace.path, gitDir: workspace.gitDir, baseCommit: workspace.baseCommit,
    commit, patchPath, summary: options.summary, changed,
  };
  await assertActive();
  durableJson(workspace.resultPath, result);
  return result;
}

export function readRunResult(path: string): RunResult {
  return JSON.parse(readFileSync(path, 'utf8')) as RunResult;
}
