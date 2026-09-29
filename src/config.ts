import { resolve } from 'node:path';
import type { EventFilters } from './events.js';
import { isRepositoryName } from './repository.js';

export interface RepositoryConfig { path?: string; baseRef: string }
export interface GitHubAppConfig {
  clientId: string;
  privateKeyPath: string;
  installationId?: number;
}
export interface ObservabilityConfig { asciinema: boolean; cols: number; rows: number; maxBytes: number }
export interface Config {
  dataDir: string;
  database: string;
  repositories: Record<string, RepositoryConfig>;
  webhookSecret: string;
  eventSource?: 'webhook' | 'poll';
  pollIntervalMs?: number;
  host: string;
  port: number;
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  maxSteps: number;
  runTimeoutMs: number;
  feedback: boolean;
  githubToken?: string;
  githubApp?: GitHubAppConfig;
  githubApiUrl: string;
  githubServerUrl: string;
  filters: EventFilters;
  extensionPath?: string;
  observability?: ObservabilityConfig;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = 2_147_483_647): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const csv = (value: string | undefined) => value?.split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repository = env.GITHUB_REPOSITORY;
  if (!isRepositoryName(repository)) throw new Error('Set GITHUB_REPOSITORY=owner/repo');
  const eventSource = env.GITHUB_EVENT_SOURCE ?? 'webhook';
  if (eventSource !== 'webhook' && eventSource !== 'poll') throw new Error('Invalid GITHUB_EVENT_SOURCE');
  if (eventSource === 'webhook' && !env.GITHUB_WEBHOOK_SECRET) throw new Error('Set GITHUB_WEBHOOK_SECRET');
  const dataDir = resolve(env.DATA_DIR ?? 'data');
  const feedback = env.GITHUB_FEEDBACK !== 'false';
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const appConfigured = Boolean(env.GITHUB_APP_CLIENT_ID || env.GITHUB_APP_PRIVATE_KEY_PATH ||
    env.GITHUB_APP_INSTALLATION_ID);
  if (appConfigured && (!clientId || !keyPath)) {
    throw new Error('Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_PATH for GitHub App authentication');
  }
  const githubApp: GitHubAppConfig | undefined = appConfigured ? {
    clientId: clientId!, privateKeyPath: resolve(keyPath!),
    ...(env.GITHUB_APP_INSTALLATION_ID ? {
      installationId: integer(env, 'GITHUB_APP_INSTALLATION_ID', 0, 1, Number.MAX_SAFE_INTEGER),
    } : {}),
  } : undefined;
  if (feedback && !githubApp && !env.GITHUB_TOKEN) {
    throw new Error('Set GitHub App credentials, GITHUB_TOKEN, or GITHUB_FEEDBACK=false');
  }
  if (eventSource === 'poll' && !githubApp && !env.GITHUB_TOKEN) {
    throw new Error('GitHub polling requires GitHub App credentials or GITHUB_TOKEN');
  }
  const labels = csv(env.ISSUE_LABELS), authors = csv(env.ISSUE_AUTHORS), botLogins = csv(env.BOT_LOGINS);
  return {
    dataDir, database: resolve(dataDir, 'queue.sqlite'),
    repositories: { [repository.toLowerCase()]: {
      ...(env.REPOSITORY_PATH ? { path: resolve(env.REPOSITORY_PATH) } : {}), baseRef: env.BASE_REF ?? 'HEAD',
    } },
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '', eventSource,
    pollIntervalMs: integer(env, 'GITHUB_POLL_INTERVAL_MS', 60_000, 10_000, 3_600_000),
    host: env.HOST ?? '127.0.0.1', port: integer(env, 'PORT', 3000, 0, 65535),
    concurrency: integer(env, 'CONCURRENCY', 2, 1, 64),
    leaseMs: integer(env, 'LEASE_MS', 60_000, 3000), maxAttempts: integer(env, 'MAX_ATTEMPTS', 3, 1, 100),
    maxSteps: integer(env, 'MAX_STEPS', 40, 1, 1000), runTimeoutMs: integer(env, 'RUN_TIMEOUT_MS', 600_000, 1000),
    feedback, ...(githubApp ? { githubApp } : env.GITHUB_TOKEN ? { githubToken: env.GITHUB_TOKEN } : {}),
    githubApiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    githubServerUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
    filters: {
      ...(labels?.length ? { labels } : {}), ...(authors?.length ? { authors } : {}), ...(botLogins?.length ? { botLogins } : {}),
      commentPrefix: env.COMMENT_PREFIX ?? '/agent',
      issueActions: csv(env.ISSUE_ACTIONS) ?? ['opened', 'reopened', 'labeled'],
    },
    ...(env.EXTENSIONS ? { extensionPath: resolve(env.EXTENSIONS) } : {}),
    observability: {
      asciinema: env.ASCIINEMA_ENABLED === 'true',
      cols: integer(env, 'ASCIINEMA_COLS', 100, 40, 240),
      rows: integer(env, 'ASCIINEMA_ROWS', 28, 10, 100),
      maxBytes: integer(env, 'ASCIINEMA_MAX_BYTES', 10_485_760, 65_536, 104_857_600),
    },
  };
}
