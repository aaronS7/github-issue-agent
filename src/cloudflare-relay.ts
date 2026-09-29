import { createHash } from 'node:crypto';
import { matchesFilters, normalizeEvent, type EventFilters } from './events.js';
import type { DurableQueue } from './queue.js';
import { verifySignature } from './webhook.js';

export interface CloudflareRelayConfig {
  relayUrl: string;
  accountId: string;
  queueId: string;
  apiToken: string;
  relayToken: string;
  pollIntervalMs: number;
}

const CONFIG_KEYS = ['CLOUDFLARE_RELAY_URL', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_QUEUE_ID',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_RELAY_TOKEN'] as const;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_API_BYTES = 131_072;
const REQUEST_TIMEOUT_MS = 20_000;
const BATCH_SIZE = 10;
const VISIBILITY_TIMEOUT_MS = 600_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadCloudflareRelayConfig(env: NodeJS.ProcessEnv = process.env): CloudflareRelayConfig | undefined {
  const configured = ['CLOUDFLARE_RELAY_URL', 'CLOUDFLARE_QUEUE_ID', 'CLOUDFLARE_RELAY_TOKEN']
    .some((key) => env[key] !== undefined);
  if (!configured) return undefined;
  for (const key of CONFIG_KEYS) if (!env[key]?.trim()) throw new Error(`Set ${key} for Cloudflare relay`);
  const rawUrl = env.CLOUDFLARE_RELAY_URL!;
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid CLOUDFLARE_RELAY_URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== rawUrl.replace(/\/$/, '')) {
    throw new Error('CLOUDFLARE_RELAY_URL must be an HTTPS origin');
  }
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_QUEUE_ID'] as const) {
    if (!/^[a-fA-F0-9]{32}$/.test(env[key]!)) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_RELAY_TOKEN'] as const) {
    if (/\s/.test(env[key]!) || env[key]!.length > 4096) throw new Error(`Invalid ${key}`);
  }
  const pollIntervalMs = env.CLOUDFLARE_POLL_INTERVAL_MS === undefined ? 5000 : Number(env.CLOUDFLARE_POLL_INTERVAL_MS);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 300_000) {
    throw new Error('Invalid CLOUDFLARE_POLL_INTERVAL_MS');
  }
  return { relayUrl: url.origin, accountId: env.CLOUDFLARE_ACCOUNT_ID!, queueId: env.CLOUDFLARE_QUEUE_ID!,
    apiToken: env.CLOUDFLARE_API_TOKEN!, relayToken: env.CLOUDFLARE_RELAY_TOKEN!, pollIntervalMs };
}

interface Pointer {
  version: 1;
  deliveryId: string;
  eventName: 'issues' | 'issue_comment';
  signature: string;
  bodySha256: string;
  objectKey: string;
}

class PersistenceFailure extends Error {}

export interface RelayLog {
  category: 'poll' | 'message' | 'payload' | 'persistence' | 'ack';
  deliveryId?: string;
  count?: number;
}

export interface CloudflareRelayOptions {
  config: CloudflareRelayConfig;
  queue: DurableQueue;
  secret: string;
  repositories: Set<string>;
  filters?: EventFilters;
  fetch?: typeof fetch;
  log?: (event: RelayLog) => void;
}

function pointer(value: unknown): Pointer | null {
  if (!record(value) || value.version !== 1 ||
      typeof value.deliveryId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.deliveryId) ||
      (value.eventName !== 'issues' && value.eventName !== 'issue_comment') ||
      typeof value.signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(value.signature) ||
      typeof value.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodySha256) ||
      value.objectKey !== `github/${value.deliveryId}/${value.bodySha256}`) return null;
  return value as unknown as Pointer;
}

function decodeMessage(value: unknown): { leaseId: string; pointer: Pointer | null } | null {
  if (!record(value) || typeof value.lease_id !== 'string' || !value.lease_id ||
      value.lease_id.length > 4096 || typeof value.body !== 'string' || value.body.length > 16_384 ||
      !record(value.metadata)) return null;
  const contentType = value.metadata['CF-Content-Type'];
  if (contentType !== 'json' && contentType !== 'bytes' && contentType !== 'text') return null;
  let body: string;
  if (contentType === 'text') body = value.body;
  else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.body)) {
      return { leaseId: value.lease_id, pointer: null };
    }
    body = Buffer.from(value.body, 'base64').toString('utf8');
  }
  try { return { leaseId: value.lease_id, pointer: pointer(JSON.parse(body)) }; }
  catch { return { leaseId: value.lease_id, pointer: null }; }
}

async function limitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Response too large');
  }
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Response too large');
      parts.push(value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error('Unable to read remote response');
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, size);
}

export class CloudflareRelay {
  private readonly fetcher: typeof fetch;
  private readonly allowed: Set<string>;
  private readonly apiBase: string;
  private readonly active = new Set<AbortController>();
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;
  private polling: Promise<{ pulled: number; acked: number; failed: number }> | undefined;

  constructor(private readonly options: CloudflareRelayOptions) {
    if (!options.secret) throw new Error('A webhook secret is required');
    this.fetcher = options.fetch ?? fetch;
    this.allowed = new Set([...options.repositories].map((name) => name.toLowerCase()));
    this.apiBase = `https://api.cloudflare.com/client/v4/accounts/${options.config.accountId}/queues/${options.config.queueId}/messages`;
  }

  private log(event: RelayLog): void { try { this.options.log?.(event); } catch { /* Logging cannot affect ack safety. */ } }

  private async request(url: string, init: RequestInit, maxBytes: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.active.add(controller);
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('Remote HTTP failure');
      const raw = await limitedBody(response, maxBytes);
      try { return JSON.parse(raw.toString('utf8')) as unknown; }
      catch { throw new Error('Malformed remote response'); }
    } finally { controller.abort(); clearTimeout(timeout); this.active.delete(controller); }
  }

  private async api(action: 'pull' | 'ack', body: unknown): Promise<unknown> {
    return this.request(`${this.apiBase}/${action}`, { method: 'POST', headers: {
      authorization: `Bearer ${this.options.config.apiToken}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) }, MAX_API_BYTES);
  }

  private async payload(item: Pointer): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.active.add(controller);
    try {
      const response = await this.fetcher(`${this.options.config.relayUrl}/payload/${item.deliveryId}/${item.bodySha256}`,
        { method: 'GET', headers: { authorization: `Bearer ${this.options.config.relayToken}` },
          redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('Payload fetch failed');
      return await limitedBody(response, MAX_PAYLOAD_BYTES);
    } finally { controller.abort(); clearTimeout(timeout); this.active.delete(controller); }
  }

  private async process(item: Pointer): Promise<void> {
    const raw = await this.payload(item);
    if (createHash('sha256').update(raw).digest('hex') !== item.bodySha256 ||
        !verifySignature(raw, item.signature, this.options.secret)) throw new Error('Payload verification failed');
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { throw new Error('Invalid payload JSON'); }
    const event = normalizeEvent(item.eventName, body, this.options.filters ? {
      ...(this.options.filters.issueActions ? { issueActions: this.options.filters.issueActions } : {}),
      ...(this.options.filters.botLogins ? { botLogins: this.options.filters.botLogins } : {}),
    } : {});
    if (!event || !this.allowed.has(event.repository.toLowerCase()) || !matchesFilters(event, this.options.filters)) return;
    try {
      this.options.queue.enqueue({ deliveryId: item.deliveryId, repository: event.repository.toLowerCase(),
        issueNumber: event.issueNumber, eventKind: event.kind, payload: event });
    } catch { throw new PersistenceFailure(); }
  }

  async pollOnce(): Promise<{ pulled: number; acked: number; failed: number }> {
    if (this.polling) return this.polling;
    if (this.stopping) return { pulled: 0, acked: 0, failed: 0 };
    const run = this.pollBatch();
    this.polling = run;
    try { return await run; } finally { this.polling = undefined; }
  }

  private async pollBatch(): Promise<{ pulled: number; acked: number; failed: number }> {
    let response: unknown;
    try { response = await this.api('pull', { batch_size: BATCH_SIZE, visibility_timeout_ms: VISIBILITY_TIMEOUT_MS }); }
    catch { this.log({ category: 'poll' }); throw new Error('Cloudflare pull failed'); }
    if (!record(response) || response.success !== true || !record(response.result) ||
        !Array.isArray(response.result.messages) || response.result.messages.length > BATCH_SIZE) {
      this.log({ category: 'poll' }); throw new Error('Malformed Cloudflare pull response');
    }
    let acked = 0, failed = 0;
    for (const raw of response.result.messages) {
      if (this.stopping) break;
      const message = decodeMessage(raw);
      if (!message || !message.pointer) { failed++; this.log({ category: 'message' }); continue; }
      try { await this.process(message.pointer); }
      catch (error) { failed++; this.log({ category: error instanceof PersistenceFailure ? 'persistence' : 'payload',
        deliveryId: message.pointer.deliveryId }); continue; }
      if (this.stopping) break;
      try {
        const ack = await this.api('ack', { acks: [{ lease_id: message.leaseId }], retries: [] });
        if (!record(ack) || ack.success !== true || !record(ack.result) || ack.result.ackCount !== 1 ||
            (record(ack.result.warnings) && Object.keys(ack.result.warnings).length > 0)) throw new Error('Ack failed');
        acked++;
      } catch { failed++; this.log({ category: 'ack', deliveryId: message.pointer.deliveryId }); }
    }
    return { pulled: response.result.messages.length, acked, failed };
  }

  start(): void {
    if (this.loop || this.stopping) return;
    this.loop = (async () => {
      let failures = 0;
      while (!this.stopping) {
        try { const result = await this.pollOnce(); failures = result.failed ? Math.min(failures + 1, 5) : 0; }
        catch { failures = Math.min(failures + 1, 5); }
        if (this.stopping) break;
        const delay = Math.min(this.options.config.pollIntervalMs * 2 ** failures,
          Math.max(this.options.config.pollIntervalMs, 60_000));
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
    try { await this.polling; } catch { /* A failed standalone poll must not prevent shutdown. */ }
  }
}
