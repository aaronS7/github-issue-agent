import { createHash } from 'node:crypto';
import { matchesFilters, normalizeEvent, type EventFilters } from './events.js';
import type { GitHubAuth } from './github-auth.js';
import type { DurableQueue } from './queue.js';
import { isRepositoryName } from './repository.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4_194_304;
const MAX_PAGES = 50;
const OVERLAP_MS = 60_000;
const MAX_SERVER_POLL_INTERVAL_MS = 2_147_483_647;
const API_VERSION = '2022-11-28';

interface Cursor {
  version: 1;
  startedAt: string;
  issuesSince: string;
  commentsSince: string;
  retryAfter?: string;
  issueEtag?: string;
  issueEtagSince?: string;
  commentEtag?: string;
  commentEtagSince?: string;
  serverPollIntervalMs?: number;
  serverPollUntil?: string;
}

export interface GitHubPollerOptions {
  queue: DurableQueue;
  auth: GitHubAuth;
  repository: string;
  apiUrl?: string;
  filters?: EventFilters;
  intervalMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: { category: 'poll' | 'issues' | 'comments' | 'rate-limit'; count?: number }) => void;
}

interface ApiPage { items: unknown[]; next?: string; etag?: string; notModified?: boolean }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return NaN;
  return Date.parse(value);
}
function validCursor(value: unknown): value is Cursor {
  return record(value) && value.version === 1 && Number.isFinite(timestamp(value.startedAt)) &&
    Number.isFinite(timestamp(value.issuesSince)) && Number.isFinite(timestamp(value.commentsSince)) &&
    (value.retryAfter === undefined || Number.isFinite(timestamp(value.retryAfter))) &&
    (value.issueEtag === undefined || typeof value.issueEtag === 'string') &&
    (value.commentEtag === undefined || typeof value.commentEtag === 'string') &&
    (value.issueEtagSince === undefined || Number.isFinite(timestamp(value.issueEtagSince))) &&
    (value.commentEtagSince === undefined || Number.isFinite(timestamp(value.commentEtagSince))) &&
    (value.serverPollUntil === undefined || Number.isFinite(timestamp(value.serverPollUntil))) &&
    (value.serverPollIntervalMs === undefined || (Number.isSafeInteger(value.serverPollIntervalMs) &&
      (value.serverPollIntervalMs as number) >= 10_000 &&
      (value.serverPollIntervalMs as number) <= MAX_SERVER_POLL_INTERVAL_MS));
}
function apiBase(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid GitHub API URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || raw.includes('\\')) {
    throw new Error('Invalid GitHub API URL');
  }
  return url.href.replace(/\/$/, '');
}
function validLink(link: string | null, current: URL, endpoint: string, first: URL): string | undefined {
  if (!link) return undefined;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)];
  const next = matches.filter((match) => match[2] === 'next');
  if (next.length === 0) return undefined;
  if (next.length !== 1 || !next[0]?.[1]) throw new Error('Invalid pagination link');
  let url: URL;
  try { url = new URL(next[0][1]); } catch { throw new Error('Invalid pagination link'); }
  if (url.origin !== first.origin || url.pathname.toLowerCase() !== endpoint.toLowerCase() ||
      url.username || url.password || url.hash ||
      url.href === current.href) throw new Error('Invalid pagination link');
  const expected = new URL(first);
  for (const [name, value] of expected.searchParams) {
    if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== value) {
      throw new Error('Invalid pagination link');
    }
  }
  const page = url.searchParams.getAll('page');
  if (page.length !== 1 || !/^[1-9]\d*$/.test(page[0] ?? '') || Number(page[0]) < 2 ||
      Number(page[0]) > MAX_PAGES || [...url.searchParams.keys()].some((key) =>
        key !== 'page' && !expected.searchParams.has(key))) throw new Error('Invalid pagination link');
  return url.href;
}

export class GitHubPoller {
  private readonly base: string;
  private readonly root: string;
  private readonly stateKey: string;
  private readonly deliveryPrefix: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly filters: EventFilters;
  private loop: Promise<void> | undefined;
  private polling: Promise<{ issues: number; comments: number; queued: number }> | undefined;
  private active = new Set<AbortController>();
  private stopping = false;
  private wake: (() => void) | undefined;
  private serverPollIntervalMs = 0;

  constructor(private readonly options: GitHubPollerOptions) {
    if (!isRepositoryName(options.repository)) throw new Error('Invalid GitHub repository');
    this.base = apiBase(options.apiUrl ?? 'https://api.github.com');
    this.root = `${this.base}/repos/${options.repository}`;
    this.stateKey = `github-poll:${this.base}:${options.repository.toLowerCase()}`;
    this.deliveryPrefix = `poll:${createHash('sha256').update(this.base).digest('hex').slice(0, 32)}:${options.repository.toLowerCase()}`;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.interval = options.intervalMs ?? 60_000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 10_000 || this.interval > 3_600_000) {
      throw new Error('Invalid GitHub poll interval');
    }
    const { issueActions: _ignored, ...filters } = options.filters ?? {};
    this.filters = filters;
  }

  private log(category: 'poll' | 'issues' | 'comments' | 'rate-limit', count?: number): void {
    try { this.options.log?.({ category, ...(count === undefined ? {} : { count }) }); } catch { /* noop */ }
  }
  private state(): Cursor {
    const existing = this.options.queue.getIngestionState(this.stateKey);
    if (existing !== undefined) {
      if (!validCursor(existing)) throw new Error('Invalid GitHub poll cursor');
      if (Number.isSafeInteger(existing.serverPollIntervalMs) &&
          existing.serverPollIntervalMs! >= 10_000 &&
          existing.serverPollIntervalMs! <= MAX_SERVER_POLL_INTERVAL_MS) {
        this.serverPollIntervalMs = Math.max(this.serverPollIntervalMs, existing.serverPollIntervalMs!);
      }
      return existing;
    }
    // GitHub list endpoints expose second-precision timestamps. Round down so the
    // first partial second is included rather than silently skipped.
    const startedAt = new Date(Math.floor(this.now() / 1000) * 1000).toISOString();
    const initial: Cursor = { version: 1, startedAt, issuesSince: startedAt, commentsSince: startedAt };
    this.options.queue.setIngestionState(this.stateKey, initial);
    return initial;
  }
  private save(state: Cursor): void { this.options.queue.setIngestionState(this.stateKey, state); }

  private async request(url: string, etag?: string): Promise<{ status: number; body?: unknown; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.active.add(controller);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = typeof this.options.auth === 'string' ? this.options.auth : await this.options.auth.getToken(controller.signal);
        let response: Response;
        try {
          response = await this.fetcher(url, { method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
              'x-github-api-version': API_VERSION, 'user-agent': 'github-issue-agent',
              ...(etag ? { 'if-none-match': etag } : {}) } });
        } catch { throw new Error('GitHub polling request failed'); }
        const requestedInterval = Number(response.headers.get('x-poll-interval')) * 1000;
        if (Number.isSafeInteger(requestedInterval) && requestedInterval >= 10_000 &&
            requestedInterval <= MAX_SERVER_POLL_INTERVAL_MS) {
          this.serverPollIntervalMs = Math.max(this.serverPollIntervalMs, requestedInterval);
        }
        if (response.status === 401 && attempt === 0 && typeof this.options.auth !== 'string') {
          void response.body?.cancel().catch(() => {});
          this.options.auth.invalidate(token);
          continue;
        }
        if (response.status === 304) { void response.body?.cancel().catch(() => {}); return { status: 304, headers: response.headers }; }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return { status: response.status, headers: response.headers };
        }
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > MAX_BODY_BYTES) throw new Error('GitHub polling response too large');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty GitHub polling response');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) throw new Error('GitHub polling response too large');
            chunks.push(value);
          }
        } catch { void reader.cancel().catch(() => {}); throw new Error('GitHub polling response failed'); }
        finally { reader.releaseLock(); }
        try { return { status: response.status, headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown }; }
        catch { throw new Error('Invalid GitHub polling JSON'); }
      }
      throw new Error('GitHub polling unauthorized');
    } finally { controller.abort(); clearTimeout(timer); this.active.delete(controller); }
  }

  private rateLimit(response: { status: number; headers: Headers }, state: Cursor): never {
    const now = this.now();
    const retryAfter = response.headers.get('retry-after');
    const retrySeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : NaN;
    const retryDate = retryAfter && !/^\d+$/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
    const reset = response.headers.get('x-ratelimit-remaining') === '0'
      ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : NaN;
    const pollInterval = Number(response.headers.get('x-poll-interval')) * 1000;
    const candidates = [now + 60_000, now + retrySeconds, retryDate, reset, now + pollInterval]
      .filter((value) => Number.isFinite(value) && value > now);
    state.retryAfter = new Date(Math.min(Math.max(...candidates), 8_640_000_000_000_000)).toISOString();
    if (this.serverPollIntervalMs) state.serverPollIntervalMs = this.serverPollIntervalMs;
    if (this.serverPollIntervalMs) state.serverPollUntil = new Date(now + this.serverPollIntervalMs).toISOString();
    this.save(state);
    this.log('rate-limit');
    throw new Error(`GitHub polling rate limited (HTTP ${response.status})`);
  }

  private async page(url: string, endpoint: string, first: URL, state: Cursor, etag?: string): Promise<ApiPage> {
    const response = await this.request(url, etag);
    if (response.status === 403 || response.status === 429) this.rateLimit(response, state);
    if (response.status === 304) return { items: [], notModified: true };
    if (response.status !== 200 || !Array.isArray(response.body)) throw new Error(`GitHub polling API failed (HTTP ${response.status})`);
    const next = validLink(response.headers.get('link'), new URL(url), endpoint, first);
    return { items: response.body, ...(next ? { next } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
  }

  private async feed(kind: 'issues' | 'comments', state: Cursor): Promise<{ seen: number; queued: number }> {
    const endpoint = kind === 'issues' ? `${new URL(this.base).pathname.replace(/\/$/, '')}/repos/${this.options.repository}/issues`
      : `${new URL(this.base).pathname.replace(/\/$/, '')}/repos/${this.options.repository}/issues/comments`;
    const cursorKey = kind === 'issues' ? 'issuesSince' : 'commentsSince';
    const etagKey = kind === 'issues' ? 'issueEtag' : 'commentEtag';
    const etagSinceKey = kind === 'issues' ? 'issueEtagSince' : 'commentEtagSince';
    // GitHub's `since` is strictly after its timestamp. Include the activation
    // second in the API query, then enforce startedAt locally on each item.
    const since = new Date(Math.max(0, timestamp(state.startedAt) - 1000,
      timestamp(state[cursorKey]) - OVERLAP_MS)).toISOString();
    const first = new URL(`${this.base}${endpoint.slice(new URL(this.base).pathname.replace(/\/$/, '').length)}`);
    if (kind === 'issues') {
      first.searchParams.set('state', 'all');
      first.searchParams.set('sort', 'updated');
      first.searchParams.set('direction', 'asc');
    } else {
      first.searchParams.set('sort', 'updated');
      first.searchParams.set('direction', 'asc');
    }
    first.searchParams.set('since', since);
    first.searchParams.set('per_page', '100');
    let url: string | undefined = first.href;
    let seen = 0, queued = 0, highest = timestamp(state[cursorKey]);
    let pages = 0, singleEtag: string | undefined;
    const visited = new Set<string>();
    while (url) {
      if (this.stopping) throw new Error('GitHub polling stopped');
      if (++pages > MAX_PAGES || visited.has(url)) throw new Error('GitHub polling pagination limit');
      visited.add(url);
      const conditional = pages === 1 && state[etagSinceKey] === since ? state[etagKey] : undefined;
      const page = await this.page(url, endpoint, first, state, conditional);
      if (page.notModified) {
        if (pages !== 1 || !conditional) throw new Error('Unexpected GitHub 304');
        return { seen: 0, queued: 0 };
      }
      if (pages === 1 && !page.next && page.items.length < 100) singleEtag = page.etag;
      for (const item of page.items) {
        if (!record(item)) throw new Error('Invalid GitHub polling item');
        const updated = timestamp(item.updated_at);
        if (!Number.isFinite(updated)) throw new Error('Invalid GitHub polling timestamp');
        highest = Math.max(highest, updated);
        seen++;
        if (updated < timestamp(state.startedAt)) continue;
        if (kind === 'issues') queued += this.issue(item);
        else queued += await this.comment(item, state);
      }
      url = page.next;
    }
    state[cursorKey] = new Date(highest).toISOString();
    if (singleEtag) { state[etagKey] = singleEtag; state[etagSinceKey] = since; }
    else { delete state[etagKey]; delete state[etagSinceKey]; }
    this.save(state);
    if (seen) this.log(kind, seen);
    return { seen, queued };
  }

  private issue(issue: Record<string, unknown>): number {
    if (issue.state !== 'open' || issue.pull_request !== undefined) return 0;
    if (typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number < 1) {
      throw new Error('Invalid GitHub issue number');
    }
    const event = normalizeEvent('issues', { action: 'opened', issue,
      repository: { full_name: this.options.repository }, sender: issue.user },
      { ...(this.filters.botLogins ? { botLogins: this.filters.botLogins } : {}) });
    if (!event || !matchesFilters(event, this.filters)) return 0;
    const deliveryId = `${this.deliveryPrefix}:issue:${issue.number}`;
    if (this.options.queue.hasDeliveryId(deliveryId)) return 0;
    this.options.queue.enqueue({ deliveryId,
      repository: this.options.repository.toLowerCase(), issueNumber: event.issueNumber,
      eventKind: event.kind, payload: event });
    return 1;
  }

  private async comment(comment: Record<string, unknown>, state: Cursor): Promise<number> {
    const created = timestamp(comment.created_at);
    if (!Number.isFinite(created) || created < timestamp(state.startedAt)) return 0;
    if (typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id < 1 ||
        typeof comment.issue_url !== 'string') throw new Error('Invalid GitHub comment');
    const deliveryId = `${this.deliveryPrefix}:comment:${comment.id}`;
    if (this.options.queue.hasDeliveryId(deliveryId)) return 0;
    const body = comment.body;
    const user = comment.user;
    if (typeof body !== 'string' || body.includes('<!-- just-bash-agent:') ||
        !record(user) || user.type === 'Bot' || typeof user.login !== 'string' ||
        !body.startsWith(this.filters.commentPrefix ?? '/agent')) return 0;
    const login = user.login;
    if (this.filters.botLogins?.some((bot) => bot.toLowerCase() === login.toLowerCase())) return 0;
    let issueUrl: URL;
    try { issueUrl = new URL(comment.issue_url); } catch { throw new Error('Invalid GitHub comment issue URL'); }
    const expectedPath = `${new URL(this.base).pathname.replace(/\/$/, '')}/repos/${this.options.repository}/issues/`;
    const issueNumber = issueUrl.pathname.slice(expectedPath.length);
    if (issueUrl.origin !== new URL(this.base).origin ||
        !issueUrl.pathname.toLowerCase().startsWith(expectedPath.toLowerCase()) ||
        !/^[1-9]\d*$/.test(issueNumber) || issueUrl.search || issueUrl.hash ||
        issueUrl.username || issueUrl.password) throw new Error('Invalid GitHub comment issue URL');
    const parent = await this.request(`${this.root}/issues/${issueNumber}`);
    if (parent.status === 403 || parent.status === 429) this.rateLimit(parent, state);
    if (parent.status !== 200 || !record(parent.body)) throw new Error('GitHub comment parent unavailable');
    const issue = parent.body;
    if (issue.number !== Number(issueNumber)) throw new Error('GitHub comment parent mismatch');
    if (issue.pull_request !== undefined) return 0;
    const event = normalizeEvent('issue_comment', { action: 'created', issue, comment,
      repository: { full_name: this.options.repository }, sender: comment.user },
      { ...(this.filters.botLogins ? { botLogins: this.filters.botLogins } : {}) });
    if (!event || !matchesFilters(event, this.filters)) return 0;
    this.options.queue.enqueue({ deliveryId,
      repository: this.options.repository.toLowerCase(), issueNumber: event.issueNumber,
      eventKind: event.kind, payload: event });
    return 1;
  }

  async pollOnce(): Promise<{ issues: number; comments: number; queued: number }> {
    if (this.polling) return this.polling;
    if (this.stopping) return { issues: 0, comments: 0, queued: 0 };
    const run = this.poll();
    this.polling = run;
    try { return await run; } finally { this.polling = undefined; }
  }
  private async poll(): Promise<{ issues: number; comments: number; queued: number }> {
    const state = this.state();
    if ((state.retryAfter && timestamp(state.retryAfter) > this.now()) ||
        (state.serverPollUntil && timestamp(state.serverPollUntil) > this.now())) {
      return { issues: 0, comments: 0, queued: 0 };
    }
    delete state.retryAfter;
    delete state.serverPollUntil;
    try {
      const issues = await this.feed('issues', state);
      const comments = await this.feed('comments', state);
      if (this.serverPollIntervalMs) {
        state.serverPollIntervalMs = this.serverPollIntervalMs;
        state.serverPollUntil = new Date(this.now() + this.serverPollIntervalMs).toISOString();
        this.save(state);
      }
      return { issues: issues.seen, comments: comments.seen, queued: issues.queued + comments.queued };
    } catch { this.log('poll'); throw new Error('GitHub polling failed'); }
  }

  start(): void {
    if (this.loop || this.stopping) return;
    this.state(); // Surface a corrupt checkpoint to the caller before starting timers.
    this.loop = (async () => {
      let failures = 0;
      while (!this.stopping) {
        try { await this.pollOnce(); failures = 0; } catch { failures = Math.min(failures + 1, 5); }
        if (this.stopping) break;
        let state: Cursor;
        try { state = this.state(); } catch { this.log('poll'); break; }
        const deadline = state.retryAfter ? timestamp(state.retryAfter) - this.now() : 0;
        const serverDeadline = state.serverPollUntil ? timestamp(state.serverPollUntil) - this.now() : 0;
        const delay = Math.min(3_600_000, Math.max(deadline, serverDeadline,
          Math.min(this.interval * 2 ** failures, Math.max(this.interval, 300_000))));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { this.wake = undefined; resolve(); }, delay);
          this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
        });
      }
    })();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    for (const controller of this.active) controller.abort();
    await this.loop;
    try { await this.polling; } catch { /* An interrupted standalone poll is already reported. */ }
  }
}
