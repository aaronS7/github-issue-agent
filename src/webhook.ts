import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { matchesFilters, normalizeEvent, type EventFilters } from './events.js';
import type { DurableQueue } from './queue.js';

export interface WebhookOptions {
  queue: DurableQueue;
  secret: string;
  repositories: Set<string>;
  filters?: EventFilters;
  maxBodyBytes?: number;
  onAccepted?: (jobId: number) => void;
}

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function verifySignature(body: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > maxBytes) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function createWebhookServer(options: WebhookOptions) {
  if (!options.secret) throw new Error('A webhook secret is required');
  const allowed = new Set([...options.repositories].map((name) => name.toLowerCase()));
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        options.queue.stats(); // Verify the database remains accessible.
        respond(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/webhooks/github') {
        respond(res, 404, { error: 'Not found' });
        return;
      }
      const maxBytes = options.maxBodyBytes ?? 1_048_576;
      if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
        respond(res, 413, { error: 'Payload too large' });
        req.resume();
        return;
      }
      const body = await readBody(req, maxBytes);
      if (!body) { respond(res, 413, { error: 'Payload too large' }); return; }
      if (!verifySignature(body, req.headers['x-hub-signature-256'], options.secret)) {
        respond(res, 401, { error: 'Invalid signature' });
        return;
      }
      const eventName = req.headers['x-github-event'];
      const deliveryId = req.headers['x-github-delivery'];
      if (typeof eventName !== 'string' || typeof deliveryId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(deliveryId)) {
        respond(res, 400, { error: 'Missing or invalid delivery headers' });
        return;
      }
      let payload: unknown;
      try { payload = JSON.parse(body.toString('utf8')); }
      catch { respond(res, 400, { error: 'Invalid JSON' }); return; }
      const event = normalizeEvent(eventName, payload,
        options.filters ? {
          ...(options.filters.issueActions ? { issueActions: options.filters.issueActions } : {}),
          ...(options.filters.botLogins ? { botLogins: options.filters.botLogins } : {}),
        } : {});
      if (!event || !allowed.has(event.repository.toLowerCase()) || !matchesFilters(event, options.filters)) {
        respond(res, 202, { ignored: true });
        return;
      }
      const jobId = options.queue.enqueue({
        deliveryId, repository: event.repository.toLowerCase(), issueNumber: event.issueNumber,
        eventKind: event.kind, payload: event,
      });
      // Acknowledge only after SQLite has committed. The worker runs independently.
      respond(res, 202, { jobId });
      try { options.onAccepted?.(jobId); } catch { /* Scheduling is also polled. */ }
    } catch {
      if (!res.headersSent && !res.destroyed) respond(res, 503, { error: 'Unable to persist delivery; redeliver later' });
      else res.destroy();
    }
  });
}
