import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import worker, { type Env, type WebhookEnvelope } from '../deploy/cloudflare/src/index.js';
import { CloudflareRelay, loadCloudflareRelayConfig } from '../src/cloudflare-relay.js';
import { DurableQueue } from '../src/queue.js';

test('Worker and local relay preserve large signed bytes and recover a lost acknowledgement after SQLite reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudflare-handoff-'));
  const path = join(root, 'queue.sqlite');
  const secret = 'fixture-webhook-secret';
  const relayToken = 'fixture-relay-token-with-at-least-thirty-two-characters';
  const objects = new Map<string, Uint8Array>();
  const messages: WebhookEnvelope[] = [];
  const env = {
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_WEBHOOK_SECRET: secret, RELAY_AUTH_TOKEN: relayToken,
    WEBHOOK_PAYLOADS: {
      async put(key: string, body: Uint8Array) { objects.set(key, body.slice()); return {}; },
      async get(key: string) {
        const raw = objects.get(key);
        return raw ? { body: new Response(raw).body, size: raw.byteLength } : null;
      },
    },
    WEBHOOK_QUEUE: { async send(pointer: WebhookEnvelope, options: { contentType: string }) {
      assert.equal(options.contentType, 'json');
      assert.ok(objects.has(pointer.objectKey), 'R2 write must precede publishing the pointer');
      messages.push(structuredClone(pointer));
    } },
  } as unknown as Env;
  const user = { login: 'alice', type: 'User' };
  // Unknown GitHub metadata is retained in R2 without inflating the Queue pointer.
  const raw = Buffer.from(JSON.stringify({ action: 'opened', sender: user,
    repository: { full_name: 'owner/repo' }, metadata: 'x'.repeat(160_000),
    issue: { number: 4, title: 'Keep signed bytes', body: 'Unicode: café 🌲\nSecond line',
      labels: [], user, html_url: 'https://github.com/owner/repo/issues/4' },
  }, null, 2));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const received = await worker.fetch(new Request('https://relay.example/webhooks/github', {
    method: 'POST', body: raw, headers: { 'x-hub-signature-256': signature,
      'x-github-event': 'issues', 'x-github-delivery': 'cross-component-fixture' },
  }), env);
  assert.equal(received.status, 202);
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(messages[0])) < 1000);
  assert.deepEqual(Buffer.from(objects.get(messages[0]!.objectKey)!), raw);

  const config = loadCloudflareRelayConfig({ CLOUDFLARE_RELAY_URL: 'https://relay.example',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_QUEUE_ID: 'b'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'fixture-queue-api-token', CLOUDFLARE_RELAY_TOKEN: relayToken,
  })!;
  let queue = new DurableQueue(path);
  let loseAck = true;
  let ackCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith('https://relay.example/')) {
      assert.equal(req.headers.get('authorization'), `Bearer ${relayToken}`);
      return worker.fetch(req, env);
    }
    assert.ok(req.url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));
    assert.equal(req.headers.get('authorization'), `Bearer ${config.apiToken}`);
    if (req.url.endsWith('/pull')) return Response.json({ success: true, result: { messages: messages.map(pointer => ({
      lease_id: 'private-lease-id', body: Buffer.from(JSON.stringify(pointer)).toString('base64'),
      metadata: { 'CF-Content-Type': 'json' },
    })) } });
    assert.ok(req.url.endsWith('/ack'));
    ackCalls++;
    // A second connection sees the committed job before the remote ack is attempted.
    const reader = new DurableQueue(path);
    try { assert.equal(reader.listJobs().length, 1); } finally { reader.close(); }
    if (loseAck) return new Response('temporary failure', { status: 503 });
    messages.length = 0;
    return Response.json({ success: true, result: { ackCount: 1, retryCount: 0, warnings: {} } });
  };
  let relay = new CloudflareRelay({ config, queue, secret, repositories: new Set(['owner/repo']), fetch: fetcher });
  try {
    assert.deepEqual(await relay.pollOnce(), { pulled: 1, acked: 0, failed: 1 });
    assert.equal(queue.listJobs().length, 1);
    await relay.stop();
    queue.close();
    queue = new DurableQueue(path);
    loseAck = false;
    relay = new CloudflareRelay({ config, queue, secret, repositories: new Set(['owner/repo']), fetch: fetcher });
    assert.deepEqual(await relay.pollOnce(), { pulled: 1, acked: 1, failed: 0 });
    assert.equal(queue.listJobs().length, 1);
    assert.equal((queue.listJobs()[0]!.payload as { body: string }).body, 'Unicode: café 🌲\nSecond line');
    assert.equal(ackCalls, 2);
    assert.equal(objects.size, 1, 'payload must survive acknowledgement for duplicate pointers');
  } finally {
    await relay.stop(); queue.close(); rmSync(root, { recursive: true, force: true });
  }
});
