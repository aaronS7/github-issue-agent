import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

const API_VERSION = '2022-11-28';
const RENEWAL_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface GitHubTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  invalidate(token: string): void;
}

export type GitHubAuth = string | GitHubTokenProvider;

export interface GitHubAppAuthOptions {
  clientId: string;
  privateKey: string;
  repository: string;
  apiUrl?: string;
  installationId?: number;
  feedback?: boolean;
}

export interface GitHubAppAuthDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

class GitHubRequestError extends Error {
  constructor(method: string, readonly status: number) {
    super(`GitHub App ${method} request failed (HTTP ${status})`);
  }
}

function repositoryParts(repository: string): { owner: string; name: string } {
  const parts = repository?.split('/');
  if (parts?.length !== 2) throw new Error('Invalid GITHUB_REPOSITORY');
  const [owner, name] = parts;
  if (!owner || !name || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid GITHUB_REPOSITORY');
  }
  return { owner, name };
}

function apiBase(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('GITHUB_API_URL must be a plain HTTPS URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('GITHUB_API_URL must be a plain HTTPS URL');
  }
  return url.href.replace(/\/$/, '');
}

function validInstallationId(id: unknown): id is number {
  return Number.isSafeInteger(id) && (id as number) > 0;
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

/** Refreshes a repository-scoped installation token when a caller needs it. */
export class GitHubAppAuth implements GitHubTokenProvider {
  private readonly clientId: string;
  private readonly key: KeyObject;
  private readonly name: string;
  private readonly repositoryPath: string;
  private readonly base: string;
  private readonly feedback: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly fixedInstallationId: boolean;
  private installationId: number | undefined;
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(options: GitHubAppAuthOptions, dependencies: GitHubAppAuthDependencies = {}) {
    if (typeof options.clientId !== 'string' || !options.clientId.trim()) {
      throw new Error('GitHub App client ID is required');
    }
    this.clientId = options.clientId;
    try { this.key = createPrivateKey(options.privateKey); }
    catch { throw new Error('Invalid GitHub App private key'); }
    if (this.key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App private key must be RSA');
    const { owner, name } = repositoryParts(options.repository);
    this.name = name;
    this.repositoryPath = `/repos/${owner}/${name}/installation`;
    this.base = apiBase(options.apiUrl ?? 'https://api.github.com');
    if (options.installationId !== undefined && !validInstallationId(options.installationId)) {
      throw new Error('Invalid GitHub App installation ID');
    }
    this.installationId = options.installationId;
    this.fixedInstallationId = options.installationId !== undefined;
    this.feedback = options.feedback ?? true;
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError();
    if (this.cached && this.cached.expiresAt - this.now() > RENEWAL_MARGIN_MS) {
      return this.cached.token;
    }
    if (!this.pending) {
      const pending = this.mint();
      this.pending = pending;
      void pending.then(() => {
        if (this.pending === pending) this.pending = undefined;
      }, () => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    return this.waitFor(this.pending, signal);
  }

  invalidate(token: string): void {
    if (this.cached?.token === token) this.cached = undefined;
  }

  private waitFor(pending: Promise<string>, signal?: AbortSignal): Promise<string> {
    if (!signal) return pending;
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(abortError()); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  private jwt(): string {
    const seconds = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Invalid current time');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540,
      iss: this.clientId })).toString('base64url');
    const input = `${header}.${claims}`;
    const signature = sign('RSA-SHA256', Buffer.from(input), this.key).toString('base64url');
    return `${input}.${signature}`;
  }

  private async request(path: string, method: 'GET' | 'POST', jwt: string, body?: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'x-github-api-version': API_VERSION,
          'user-agent': 'github-issue-agent',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`GitHub App ${method} request failed`);
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* A failed body close cannot expose its contents. */ }
      throw new GitHubRequestError(method, response.status);
    }
    try { return await response.json(); }
    catch { throw new Error(`GitHub App ${method} returned invalid JSON`); }
  }

  private async discover(jwt: string): Promise<number> {
    const body = await this.request(this.repositoryPath, 'GET', jwt);
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
    if (!validInstallationId(id)) throw new Error('GitHub returned an invalid installation ID');
    this.installationId = id;
    return id;
  }

  private async mint(): Promise<string> {
    const jwt = this.jwt();
    let id = this.installationId ?? await this.discover(jwt);
    const body = { repositories: [this.name], permissions: {
      contents: 'read', ...(this.feedback ? { issues: 'write' } : {}),
    } };
    let issued: unknown;
    try {
      issued = await this.request(`/app/installations/${id}/access_tokens`, 'POST', jwt, body);
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 404 || this.fixedInstallationId) throw error;
      this.installationId = undefined;
      id = await this.discover(jwt);
      issued = await this.request(`/app/installations/${id}/access_tokens`, 'POST', jwt, body);
    }
    const value = typeof issued === 'object' && issued !== null
      ? issued as { token?: unknown; expires_at?: unknown } : {};
    const expiresAt = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN;
    if (typeof value.token !== 'string' || !value.token || /\s/.test(value.token) ||
        !Number.isFinite(expiresAt) || expiresAt - this.now() <= RENEWAL_MARGIN_MS) {
      throw new Error('GitHub returned an invalid installation token response');
    }
    this.cached = { token: value.token, expiresAt };
    return value.token;
  }
}
