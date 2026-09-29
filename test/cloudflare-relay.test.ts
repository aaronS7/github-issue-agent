import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { CloudflareRelay, loadCloudflareRelayConfig, type CloudflareRelayConfig } from '../src/cloudflare-relay.js';
import { DurableQueue } from '../src/queue.js';

const accountId = 'a'.repeat(32), queueId = 'b'.repeat(32);
const config: CloudflareRelayConfig = { relayUrl: 'https://relay.example', accountId, queueId,
  apiToken: 'api-token', relayToken: 'relay-token', pollIntervalMs: 1000 };
const payload = { action: 'opened', issue: { number: 42, title: 'Title', body: 'Body',
  html_url: 'https://github.com/acme/widgets/issues/42', user: { login: 'Alice' }, labels: [] },
repository: { full_name: 'acme/widgets' }, sender: { login: 'Alice' } };
const secret = 'secret';
const raw = Buffer.from(JSON.stringify(payload));
const sha = createHash('sha256').update(raw).digest('hex');
const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const pointer = { version: 1, deliveryId: 'delivery-1', eventName: 'issues', signature,
  bodySha256: sha, objectKey: `github/delivery-1/${sha}` };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pull = (body: unknown, contentType = 'json', lease = 'lease-1') => reply({ success: true,
  result: { messages: [{ id: 'message-1', lease_id: lease, metadata: { 'CF-Content-Type': contentType },
    body: contentType === 'text' ? JSON.stringify(body) : Buffer.from(JSON.stringify(body)).toString('base64') }] } });
const empty = () => reply({ success: true, result: { messages: [] } });
const ack = () => reply({ success: true, result: { ackCount: 1, retryCount: 0 } });

function consumer(fetcher: typeof fetch, queue: DurableQueue, filters?: { labels?: string[] }) {
  return new CloudflareRelay({ config, queue, secret, repositories: new Set(['acme/widgets']),
    fetch: fetcher, ...(filters ? { filters } : {}) });
}

test('config only activates on relay-specific settings and validates safely', () => {
  assert.equal(loadCloudflareRelayConfig({ CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: 'wrangler-token', CLOUDFLARE_POLL_INTERVAL_MS: '1000' }), undefined);
  assert.deepEqual(loadCloudflareRelayConfig({ CLOUDFLARE_RELAY_URL: 'https://relay.example',
    CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_QUEUE_ID: queueId,
    CLOUDFLARE_API_TOKEN: 'api-token', CLOUDFLARE_RELAY_TOKEN: 'relay-token' }), { ...config, pollIntervalMs: 5000 });
  assert.throws(() => loadCloudflareRelayConfig({ CLOUDFLARE_RELAY_URL: 'https://relay.example' }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(() => loadCloudflareRelayConfig({ ...{
    CLOUDFLARE_RELAY_URL: 'https://relay.example/path', CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_QUEUE_ID: queueId, CLOUDFLARE_API_TOKEN: 'api-token', CLOUDFLARE_RELAY_TOKEN: 'relay-token',
  } }), /HTTPS origin/);
});

test('decodes Cloudflare JSON base64, commits before ack, and tolerates lost ack and redelivery', async () => {
  const queue = new DurableQueue(':memory:');
  let pulls = 0, ackCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error');
    if (url.endsWith('/pull')) {
      pulls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { batch_size: 10, visibility_timeout_ms: 600000 });
      return pull(pointer);
    }
    if (url.includes('/payload/')) {
      assert.equal(url, `https://relay.example/payload/delivery-1/${sha}`);
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer relay-token');
      return new Response(raw);
    }
    if (url.endsWith('/ack')) {
      ackCalls++;
      assert.equal(queue.stats().jobs.queued, 1);
      assert.deepEqual(JSON.parse(String(init?.body)), { acks: [{ lease_id: 'lease-1' }], retries: [] });
      if (ackCalls === 1) throw new Error('token and payload must never leak');
      return ack();
    }
    throw new Error('Unexpected URL');
  };
  const relay = consumer(fetcher, queue);
  try {
    assert.deepEqual(await relay.pollOnce(), { pulled: 1, acked: 0, failed: 1 });
    assert.deepEqual(await relay.pollOnce(), { pulled: 1, acked: 1, failed: 0 });
    assert.equal(pulls, 2);
    assert.equal(queue.listJobs().length, 1);
  } finally { queue.close(); }
});

test('does not ack invalid pointer, bad signature, missing payload, or persistence failure', async () => {
  for (const scenario of ['path', 'signature', 'missing', 'persistence']) {
    const queue = new DurableQueue(':memory:');
    let acked = false;
    const changed = scenario === 'path' ? { ...pointer, objectKey: '../bad' } :
      scenario === 'signature' ? { ...pointer, signature: `sha256=${'0'.repeat(64)}` } : pointer;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/pull')) return pull(changed);
      if (url.includes('/payload/')) return scenario === 'missing' ? new Response(null, { status: 404 }) : new Response(raw);
      if (url.endsWith('/ack')) { acked = true; return ack(); }
      throw new Error('Unexpected URL');
    };
    if (scenario === 'persistence') queue.close();
    const relay = consumer(fetcher, queue);
    assert.deepEqual(await relay.pollOnce(), { pulled: 1, acked: 0, failed: 1 });
    assert.equal(acked, false);
    if (scenario !== 'persistence') queue.close();
  }
});

test('acks valid ignored event and accepts text wire encoding', async () => {
  const queue = new DurableQueue(':memory:');
  let acks = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/pull')) return pull(pointer, 'text');
    if (url.includes('/payload/')) return new Response(raw);
    if (url.endsWith('/ack')) { acks++; return ack(); }
    return empty();
  };
  try {
    assert.deepEqual(await consumer(fetcher, queue, { labels: ['must-have'] }).pollOnce(),
      { pulled: 1, acked: 1, failed: 0 });
    assert.equal(acks, 1);
    assert.equal(queue.listJobs().length, 0);
  } finally { queue.close(); }
});

test('malformed API response and redirected payload are safe', async () => {
  const queue = new DurableQueue(':memory:');
  try {
    await assert.rejects(consumer(async () => reply({ success: true }), queue).pollOnce(), /Malformed Cloudflare/);
    let acked = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/pull')) return pull(pointer);
      if (url.includes('/payload/')) {
        assert.equal(init?.redirect, 'error');
        throw new Error('redirect blocked');
      }
      acked = true;
      return ack();
    };
    assert.deepEqual(await consumer(fetcher, queue).pollOnce(), { pulled: 1, acked: 0, failed: 1 });
    assert.equal(acked, false);
  } finally { queue.close(); }
});

test('stop aborts an in-flight fetch and waits for exit', async () => {
  const queue = new DurableQueue(':memory:');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    entered();
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const relay = consumer(fetcher, queue);
  relay.start();
  await started;
  await relay.stop();
  queue.close();
});
