import { createHash } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { loadConfig } from './config.js';
import { isRepositoryName } from './repository.js';
import { loadCloudflareRelayConfig } from './cloudflare-relay.js';

export const DEFAULT_VALUES: Readonly<Record<string, string>> = Object.freeze({
  GITHUB_REPOSITORY: '', GITHUB_APP_CLIENT_ID: '', GITHUB_APP_PRIVATE_KEY_PATH: '',
  GITHUB_APP_INSTALLATION_ID: '', REPOSITORY_PATH: '', BASE_REF: 'HEAD',
  MODEL_PROVIDER: 'anthropic', MODEL: '', MODEL_BASE_URL: '', DATA_DIR: './data',
  HOST: '127.0.0.1', PORT: '3000', CONCURRENCY: '2', LEASE_MS: '60000',
  MAX_ATTEMPTS: '3', MAX_STEPS: '40', RUN_TIMEOUT_MS: '600000',
  ISSUE_ACTIONS: 'opened,reopened,labeled', ISSUE_LABELS: '', ISSUE_AUTHORS: '',
  BOT_LOGINS: '', COMMENT_PREFIX: '/agent', GITHUB_FEEDBACK: 'true',
  GITHUB_EVENT_SOURCE: 'webhook', GITHUB_POLL_INTERVAL_MS: '60000',
  EXTENSIONS: '', GITHUB_SERVER_URL: '', GITHUB_API_URL: '',
  ASCIINEMA_ENABLED: 'false', ASCIINEMA_COLS: '100', ASCIINEMA_ROWS: '28',
  ASCIINEMA_MAX_BYTES: '10485760',
  CLOUDFLARE_RELAY_URL: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_QUEUE_ID: '',
  CLOUDFLARE_POLL_INTERVAL_MS: '5000',
});
export const SECRET_KEYS = ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'MODEL_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_RELAY_TOKEN'] as const;
const secretKeys = new Set<string>([...SECRET_KEYS, 'ANTHROPIC_API_KEY']);
const valueKeys = new Set(Object.keys(DEFAULT_VALUES));
const managedKeys = new Set([...valueKeys, ...secretKeys]);
const integerBounds: Record<string, [number, number]> = {
  GITHUB_APP_INSTALLATION_ID: [1, Number.MAX_SAFE_INTEGER], PORT: [0, 65535],
  CONCURRENCY: [1, 64], LEASE_MS: [3000, 2147483647], MAX_ATTEMPTS: [1, 100],
  MAX_STEPS: [1, 1000], RUN_TIMEOUT_MS: [1000, 2147483647],
  ASCIINEMA_COLS: [40, 240], ASCIINEMA_ROWS: [10, 100], ASCIINEMA_MAX_BYTES: [65536, 104857600],
  CLOUDFLARE_POLL_INTERVAL_MS: [1000, 300000],
  GITHUB_POLL_INTERVAL_MS: [10000, 3600000],
};

export interface ConfigDraft {
  values: Record<string, string>;
  secrets: Record<string, string | null>;
  revision?: string;
}
export interface ConfigSnapshot {
  values: Record<string, string>;
  secrets: Record<string, boolean>;
  revision: string;
  file: string;
  exists: boolean;
  csrfToken: string;
}
export class ConfigInputError extends Error {
  constructor(readonly errors: Record<string, string>) { super('Invalid configuration'); }
}
export class ConfigConflictError extends Error {
  constructor() { super('Configuration changed; reload and try again'); }
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDraft(body: unknown): ConfigDraft {
  if (!ownRecord(body) || !ownRecord(body.values) || !ownRecord(body.secrets)) {
    throw new ConfigInputError({ form: 'Expected values and secrets objects' });
  }
  const errors: Record<string, string> = Object.create(null);
  const values: Record<string, string> = Object.create(null);
  const secrets: Record<string, string | null> = Object.create(null);
  for (const [key, value] of Object.entries(body.values)) {
    if (!valueKeys.has(key) || typeof value !== 'string') errors[key] = 'Unknown field or invalid value';
    else values[key] = value;
  }
  for (const [key, value] of Object.entries(body.secrets)) {
    if (!secretKeys.has(key) || (value !== null && typeof value !== 'string')) {
      errors[key] = 'Unknown secret or invalid value';
    } else secrets[key] = value;
  }
  if (body.revision !== undefined && typeof body.revision !== 'string') errors.revision = 'Invalid revision';
  if (Object.keys(errors).length) throw new ConfigInputError(errors);
  return { values, secrets, ...(typeof body.revision === 'string' ? { revision: body.revision } : {}) };
}

function revision(raw: string | undefined): string {
  return createHash('sha256').update(raw === undefined ? '\0missing' : `\0present${raw}`).digest('hex');
}

async function readEnv(path: string): Promise<{ raw: string | undefined; env: Record<string, string> }> {
  let raw: string | undefined;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { raw, env: raw === undefined ? {} : Object.fromEntries(
    Object.entries(parseEnv(raw)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ) };
}

function encode(value: string): string {
  if (value === '') return '';
  // parseEnv treats quoted contents literally, except for double-quoted backslash-n.
  for (const quote of ["'", '`', '"']) {
    if (!value.includes(quote) && !(quote === '"' && value.includes('\\n'))) return `${quote}${value}${quote}`;
  }
  if (!/[#\r\n]/.test(value) && value === value.trim()) return value;
  throw new Error('Value cannot be represented in a Node .env file');
}

function render(raw: string | undefined, env: Record<string, string>): string {
  const source = raw ?? '';
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  const written = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key) { out.push(line); continue; }
    // A quoted .env value may span physical lines. Keep unknown records intact,
    // even when their contents resemble managed assignments.
    const record = [line];
    const opening = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(['"`])/.exec(line);
    if (opening) {
      const quote = opening[1]!;
      let remainder = line.slice(opening[0].length);
      while (!remainder.includes(quote) && index + 1 < lines.length) {
        remainder = lines[++index]!;
        record.push(remainder);
      }
    }
    if (!managedKeys.has(key)) { out.push(...record); continue; }
    if (written.has(key)) continue;
    written.add(key);
    if (env[key] !== undefined && (env[key] !== '' || key === 'COMMENT_PREFIX' || key === 'ISSUE_ACTIONS')) {
      out.push(`${key}=${encode(env[key])}`);
    }
  }
  for (const key of managedKeys) {
    if (!written.has(key) && env[key] !== undefined &&
      (env[key] !== '' || key === 'COMMENT_PREFIX' || key === 'ISSUE_ACTIONS')) out.push(`${key}=${encode(env[key])}`);
  }
  return `${out.join('\n').replace(/\n*$/, '')}\n`;
}

function merged(env: Record<string, string>, draft: ConfigDraft): Record<string, string> {
  const next = { ...env, ...draft.values };
  for (const [key, value] of Object.entries(draft.secrets)) {
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  for (const key of managedKeys) {
    if (next[key] === '' && key !== 'COMMENT_PREFIX' && key !== 'ISSUE_ACTIONS') delete next[key];
  }
  return next;
}

function plainUrl(value: string, key: string, errors: Record<string, string>): void {
  if (!value) return;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) throw new Error();
  } catch { errors[key] = 'Enter a plain HTTPS URL (HTTP is allowed for localhost)'; }
}

export function validateFields(env: Record<string, string>, ready = false): Record<string, string> {
  const errors: Record<string, string> = {};
  if (env.GITHUB_REPOSITORY && !isRepositoryName(env.GITHUB_REPOSITORY)) errors.GITHUB_REPOSITORY = 'Use owner/repository';
  if (env.MODEL_PROVIDER && !['anthropic', 'openai-compatible'].includes(env.MODEL_PROVIDER)) errors.MODEL_PROVIDER = 'Choose a supported provider';
  if (env.GITHUB_FEEDBACK && !['true', 'false'].includes(env.GITHUB_FEEDBACK)) errors.GITHUB_FEEDBACK = 'Use true or false';
  if (env.GITHUB_EVENT_SOURCE && !['webhook', 'poll'].includes(env.GITHUB_EVENT_SOURCE)) errors.GITHUB_EVENT_SOURCE = 'Choose webhook or poll';
  if (env.ASCIINEMA_ENABLED && !['true', 'false'].includes(env.ASCIINEMA_ENABLED)) errors.ASCIINEMA_ENABLED = 'Use true or false';
  for (const [key, [min, max]] of Object.entries(integerBounds)) {
    const value = env[key];
    if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)) {
      errors[key] = `Enter an integer from ${min} to ${max}`;
    }
  }
  for (const key of ['GITHUB_SERVER_URL', 'GITHUB_API_URL', 'MODEL_BASE_URL']) plainUrl(env[key] ?? '', key, errors);
  if (env.CLOUDFLARE_RELAY_URL) {
    try {
      const url = new URL(env.CLOUDFLARE_RELAY_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    } catch { errors.CLOUDFLARE_RELAY_URL = 'Enter an HTTPS origin without a path, query, or credentials'; }
  }
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_QUEUE_ID']) {
    if (env[key] && !/^[a-fA-F0-9]{32}$/.test(env[key])) errors[key] = 'Enter the 32-character hexadecimal ID';
  }
  for (const key of managedKeys) {
    const value = env[key];
    if (value === undefined) continue;
    try { encode(value); }
    catch { errors[key] = 'This value cannot be saved to a Node .env file'; }
  }
  if (ready) {
    try { if (env.GITHUB_EVENT_SOURCE !== 'poll') loadCloudflareRelayConfig(env); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Cloudflare relay settings';
      const key = message.match(/CLOUDFLARE_[A-Z_]+/)?.[0] ?? 'CLOUDFLARE_RELAY_URL';
      errors[key] = message;
    }
    if (!env.GITHUB_REPOSITORY && !errors.GITHUB_REPOSITORY) errors.GITHUB_REPOSITORY = 'Enter a repository';
    if (env.GITHUB_EVENT_SOURCE !== 'poll' && !env.GITHUB_WEBHOOK_SECRET) errors.GITHUB_WEBHOOK_SECRET = 'Enter a webhook secret';
    const provider = env.MODEL_PROVIDER || 'anthropic';
    if (!env.EXTENSIONS) {
      if (!env.MODEL) errors.MODEL = 'Enter a model ID';
      if (provider === 'anthropic' && !env.MODEL_API_KEY && !env.ANTHROPIC_API_KEY) {
        errors.MODEL_API_KEY = 'Enter a model API key';
      }
      if (provider === 'openai-compatible' && !env.MODEL_BASE_URL) errors.MODEL_BASE_URL = 'Enter an API base URL';
    }
    const appConfigured = Boolean(env.GITHUB_APP_CLIENT_ID || env.GITHUB_APP_PRIVATE_KEY_PATH || env.GITHUB_APP_INSTALLATION_ID);
    if (appConfigured) {
      if (!env.GITHUB_APP_CLIENT_ID) errors.GITHUB_APP_CLIENT_ID = 'Enter the GitHub App client ID';
      if (!env.GITHUB_APP_PRIVATE_KEY_PATH) errors.GITHUB_APP_PRIVATE_KEY_PATH = 'Enter the GitHub App private key path';
    } else if ((env.GITHUB_EVENT_SOURCE === 'poll' || env.GITHUB_FEEDBACK !== 'false') && !env.GITHUB_TOKEN) {
      errors.GITHUB_TOKEN = env.GITHUB_EVENT_SOURCE === 'poll'
        ? 'Polling requires GitHub App credentials or a GitHub token'
        : 'Enter GitHub App credentials or a GitHub token, or disable feedback';
    }
    if (!Object.keys(errors).length) {
      try { loadConfig(env); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid configuration';
        const key = message.match(/(?:Set|Invalid) ([A-Z_]+)/)?.[1] ?? 'form';
        errors[key] = message;
      }
    }
  }
  return errors;
}

export class ConfigStore {
  readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(path = '.env') { this.path = resolve(path); }

  async current(): Promise<{ raw: string | undefined; env: Record<string, string>; revision: string }> {
    const { raw, env } = await readEnv(this.path);
    return { raw, env, revision: revision(raw) };
  }

  async snapshot(csrfToken: string): Promise<ConfigSnapshot> {
    const { raw, env, revision: currentRevision } = await this.current();
    const values = { ...DEFAULT_VALUES };
    for (const key of valueKeys) if (env[key] !== undefined) values[key] = env[key];
    const secrets: Record<string, boolean> = {};
    for (const key of secretKeys) secrets[key] = Boolean(env[key]);
    return { values, secrets, revision: currentRevision, file: this.path, exists: raw !== undefined, csrfToken };
  }

  async draftEnv(draft: ConfigDraft): Promise<Record<string, string>> {
    const { env } = await this.current();
    return merged(env, draft);
  }

  async save(draft: ConfigDraft, csrfToken: string): Promise<ConfigSnapshot> {
    const operation = async (): Promise<ConfigSnapshot> => {
      const { raw, env, revision: currentRevision } = await this.current();
      if (!draft.revision || draft.revision !== currentRevision) throw new ConfigConflictError();
      const next = merged(env, draft);
      const errors = validateFields(next);
      if (Object.keys(errors).length) throw new ConfigInputError(errors);
      const content = render(raw, next);
      // Verify the exact bytes Node will read before replacing the old file.
      const parsed = parseEnv(content);
      for (const key of managedKeys) {
        if ((parsed[key] ?? '') !== (next[key] ?? '')) throw new ConfigInputError({ [key]: 'Value cannot be saved safely' });
      }
      const directory = dirname(this.path);
      const temp = join(directory, `.${basename(this.path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
      let created = false;
      try {
        const handle = await open(temp, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, this.path);
        created = false;
        const dir = await open(directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { if (created) await unlink(temp).catch(() => undefined); }
      return this.snapshot(csrfToken);
    };
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
