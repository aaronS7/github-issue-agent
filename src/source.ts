import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isRepositoryName } from './repository.js';
import type { GitHubAuth } from './github-auth.js';

const execFileAsync = promisify(execFile);
interface PendingSource {
  promise: Promise<string>;
  controller: AbortController;
  consumers: number;
}
const pendingSources = new Map<string, PendingSource>();

export interface GitHubSourceOptions {
  repository: string;
  rootDir: string;
  token?: string;
  auth?: GitHubAuth;
  serverUrl?: string;
}

function validatedRepository(value: string): string {
  if (!isRepositoryName(value)) {
    throw new TypeError('Repository must be owner/name');
  }
  return value;
}

function remoteUrl(serverUrl: string, repository: string): { url: string; origin: string } {
  const server = new URL(serverUrl);
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) {
    throw new TypeError('GitHub server URL must be HTTPS without credentials or query');
  }
  const base = new URL(server.href.endsWith('/') ? server.href : `${server.href}/`);
  return { url: new URL(`${repository}.git`, base).href, origin: server.origin };
}

function gitEnvironment(token: string | undefined, origin: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && key !== 'SSH_ASKPASS'));
  const clean: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (token) {
    clean.GIT_CONFIG_COUNT = '1';
    clean.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    clean.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return clean;
}

async function git(args: string[], cwd: string, auth: GitHubAuth | undefined,
                   origin: string, signal?: AbortSignal, beforeRetry?: () => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const token = typeof auth === 'object' ? await auth.getToken(signal) : auth;
    signal?.throwIfAborted();
    try {
      await execFileAsync('git', [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsync=committed',
        '-c', 'credential.helper=',
        '-c', 'http.followRedirects=false',
        ...args,
      ], { cwd, env: gitEnvironment(token, origin), signal, maxBuffer: 4 * 1024 * 1024 });
      return;
    } catch (error) {
      signal?.throwIfAborted();
      const rejected = /Authentication failed|returned error: 401/i.test(
        String((error as { stderr?: unknown }).stderr ?? ''));
      if (rejected && typeof auth === 'object' && token !== undefined) {
        auth.invalidate(token);
        if (attempt === 0) {
          beforeRetry?.();
          continue;
        }
      }
      // Do not retain Git stderr: an HTTP peer can echo authentication material there.
      const operation = args.includes('clone') ? 'clone' : 'fetch';
      throw new Error(`GitHub repository ${operation} failed${rejected ? ' (authentication rejected)' : ''}`);
    }
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function updateSource(options: GitHubSourceOptions, signal?: AbortSignal): Promise<string> {
  const repository = validatedRepository(options.repository);
  const { url, origin } = remoteUrl(options.serverUrl ?? 'https://github.com', repository);
  const auth = options.auth ?? options.token;
  const sourcesDir = join(resolve(options.rootDir), 'sources');
  const digest = createHash('sha256').update(url.toLowerCase()).digest('hex');
  const target = join(sourcesDir, digest);
  mkdirSync(sourcesDir, { recursive: true });
  if (!existsSync(target)) {
    const temporary = join(sourcesDir, `.${digest}-${randomUUID()}.tmp`);
    try {
      await git(['clone', '--mirror', '--no-local', '--', url, temporary],
        sourcesDir, auth, origin, signal, () => rmSync(temporary, { recursive: true, force: true }));
      try {
        renameSync(temporary, target);
        syncDirectory(sourcesDir);
        return target;
      } catch (error) {
        if (!existsSync(target)) throw error;
      }
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
  }
  // Use the constructed URL on refresh, never a cached remote URL that may have been edited.
  await git([`--git-dir=${target}`, 'fetch', '--prune', url,
    '+refs/heads/*:refs/heads/*'], sourcesDir, auth, origin, signal);
  return target;
}

/** Obtain a managed local Git source without persisting GitHub credentials. */
export async function ensureGitHubSource(options: GitHubSourceOptions,
                                         signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const repository = validatedRepository(options.repository);
  const key = `${resolve(options.rootDir)}\0${(options.serverUrl ?? 'https://github.com').toLowerCase()}\0${repository.toLowerCase()}`;
  let entry = pendingSources.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, promise: updateSource(options, controller.signal), consumers: 0 };
    pendingSources.set(key, entry);
    const started = entry;
    const clear = () => { if (pendingSources.get(key) === started) pendingSources.delete(key); };
    // Register both outcomes so a canceled, now ownerless operation cannot reject unhandled.
    void started.promise.then(clear, clear);
  }
  const shared = entry;
  shared.consumers++;
  try {
    if (!signal) return await shared.promise;
    return await new Promise<string>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      shared.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  } finally {
    shared.consumers--;
    if (shared.consumers === 0 && pendingSources.get(key) === shared) {
      pendingSources.delete(key);
      shared.controller.abort();
    }
  }
}
