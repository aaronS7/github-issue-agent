import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import test from "node:test";
import worker, { type Env, type WebhookEnvelope } from "../src/index.ts";

const url = "https://relay.example/webhooks/github";
const secret = "webhook-secret";
const token = "relay-token";
const deliveryId = "12345678-abcd";
const body = Buffer.from('{"repository":{"full_name":"owner/repo"},"issue":{"number":7}}\n');
const signature = (bytes: Uint8Array) => `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const messages: { envelope: WebhookEnvelope; options: unknown }[] = [];
  const order: string[] = [];
  const env = {
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_WEBHOOK_SECRET: secret,
    RELAY_AUTH_TOKEN: token,
    WEBHOOK_PAYLOADS: {
      async put(key: string, value: Uint8Array) {
        order.push("put");
        objects.set(key, new Uint8Array(value));
      },
      async get(key: string) {
        order.push("get");
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength, body: new Blob([Uint8Array.from(bytes)]).stream() } : null;
      }
    },
    WEBHOOK_QUEUE: {
      async send(envelope: WebhookEnvelope, options: unknown) {
        order.push("send");
        messages.push({ envelope, options });
      }
    }
  };
  return { env, objects, messages, order };
}

function post(bytes: Uint8Array = body, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": "issues",
      "X-Hub-Signature-256": signature(bytes),
      ...headers
    },
    body: Uint8Array.from(bytes).buffer
  });
}

async function fetch(request: Request, env: ReturnType<typeof fixture>["env"]) {
  return worker.fetch(request, env as unknown as Env);
}

test("stores exact signed bytes before publishing a JSON pointer", async () => {
  const f = fixture();
  const res = await fetch(post(), f.env);
  assert.equal(res.status, 202);
  const key = `github/${deliveryId}/${digest(body)}`;
  assert.deepEqual(f.order, ["put", "send"]);
  assert.deepEqual(Buffer.from(f.objects.get(key)!), body);
  assert.deepEqual(f.messages, [{
    envelope: { version: 1, deliveryId, eventName: "issues", signature: signature(body), bodySha256: digest(body), objectKey: key },
    options: { contentType: "json" }
  }]);
});

test("rejects invalid signatures, delivery IDs, and malformed JSON without writing", async () => {
  const f = fixture();
  assert.equal((await fetch(post(body, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) }), f.env)).status, 401);
  assert.equal((await fetch(post(body, { "X-Hub-Signature-256": signature(body).toUpperCase().replace("SHA256=", "sha256=") }), f.env)).status, 401);
  assert.equal((await fetch(post(body, { "X-GitHub-Delivery": "../other" }), f.env)).status, 400);
  const malformed = Buffer.from("{bad");
  assert.equal((await fetch(post(malformed), f.env)).status, 400);
  assert.deepEqual(f.order, []);
});

test("matches repository names without regard to case", async () => {
  const f = fixture();
  f.env.GITHUB_REPOSITORY = "OWNER/Repo";
  assert.equal((await fetch(post(), f.env)).status, 202);
  assert.equal(f.messages.length, 1);
});

test("caps streamed request bodies even without Content-Length", async () => {
  const f = fixture();
  const oversized = Buffer.alloc(1_048_577, 32);
  const request = new Request(url, {
    method: "POST",
    duplex: "half",
    headers: { "X-GitHub-Delivery": deliveryId, "X-GitHub-Event": "issues", "X-Hub-Signature-256": signature(oversized) },
    body: new ReadableStream({ start(controller) { controller.enqueue(oversized); controller.close(); } })
  } as RequestInit);
  assert.equal((await fetch(request, f.env)).status, 413);
  assert.deepEqual(f.order, []);
});

test("returns a sanitized 503 when the request stream fails", async () => {
  const f = fixture();
  const request = new Request(url, {
    method: "POST",
    duplex: "half",
    headers: { "X-GitHub-Delivery": deliveryId, "X-GitHub-Event": "issues", "X-Hub-Signature-256": signature(body) },
    body: new ReadableStream({ pull() { throw new Error("stream secret details"); } })
  } as RequestInit);
  const result = await fetch(request, f.env);
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /stream secret details/);
  assert.deepEqual(f.order, []);
});

test("accepts signed ping, ignores other events and repositories", async () => {
  const f = fixture();
  assert.equal((await fetch(post(body, { "X-GitHub-Event": "ping" }), f.env)).status, 200);
  assert.equal((await fetch(post(body, { "X-GitHub-Event": "push" }), f.env)).status, 202);
  const nonJson = Buffer.from("not-json");
  assert.equal((await fetch(post(nonJson, { "X-GitHub-Event": "ping" }), f.env)).status, 200);
  assert.equal((await fetch(post(nonJson, { "X-GitHub-Event": "push" }), f.env)).status, 202);
  const other = Buffer.from('{"repository":{"full_name":"other/repo"}}');
  assert.equal((await fetch(post(other), f.env)).status, 202);
  assert.deepEqual(f.order, []);
});

test("payload fetch requires bearer token and exact key shape; duplicate pointers can refetch", async () => {
  const f = fixture();
  await fetch(post(), f.env);
  const payloadUrl = `https://relay.example/payload/${deliveryId}/${digest(body)}`;
  assert.equal((await fetch(new Request(payloadUrl), f.env)).status, 401);
  assert.equal((await fetch(new Request(payloadUrl, { headers: { Authorization: "Bearer wrong" } }), f.env)).status, 401);
  assert.equal((await fetch(new Request("https://relay.example/payload/../bucket/anything", { headers: { Authorization: `Bearer ${token}` } }), f.env)).status, 404);
  for (let i = 0; i < 2; i++) {
    const res = await fetch(new Request(payloadUrl, { headers: { Authorization: `Bearer ${token}` } }), f.env);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), body);
  }
  assert.equal(f.order.filter(x => x === "get").length, 2);
});

test("refuses an unexpectedly oversized R2 object", async () => {
  const f = fixture();
  const key = `github/${deliveryId}/${digest(body)}`;
  f.objects.set(key, Buffer.alloc(1_048_577));
  const payloadUrl = `https://relay.example/payload/${deliveryId}/${digest(body)}`;
  const result = await fetch(new Request(payloadUrl, { headers: { Authorization: `Bearer ${token}` } }), f.env);
  assert.equal(result.status, 503);
});

test("persistence failures return 503; queue send waits for R2 completion", async () => {
  const f = fixture();
  let resolvePut!: () => void;
  let signalPut!: () => void;
  const enteredPut = new Promise<void>(resolve => { signalPut = resolve; });
  const pending = new Promise<void>(resolve => { resolvePut = resolve; });
  f.env.WEBHOOK_PAYLOADS.put = async () => { f.order.push("put"); signalPut(); await pending; };
  const response = fetch(post(), f.env);
  await enteredPut;
  assert.deepEqual(f.order, ["put"]);
  resolvePut();
  assert.equal((await response).status, 202);
  assert.deepEqual(f.order, ["put", "send"]);

  const r2Failure = fixture();
  r2Failure.env.WEBHOOK_PAYLOADS.put = async () => { throw new Error("private failure details"); };
  const r2Res = await fetch(post(), r2Failure.env);
  assert.equal(r2Res.status, 503);
  assert.doesNotMatch(await r2Res.text(), /private failure details/);
  assert.equal(r2Failure.messages.length, 0);

  const queueFailure = fixture();
  queueFailure.env.WEBHOOK_QUEUE.send = async () => { throw new Error("queue unavailable"); };
  assert.equal((await fetch(post(), queueFailure.env)).status, 503);
});

test("missing or placeholder configuration fails closed", async () => {
  const f = fixture();
  f.env.GITHUB_REPOSITORY = "CHANGE_ME_OWNER/REPO";
  assert.equal((await fetch(post(), f.env)).status, 503);
  const f2 = fixture();
  f2.env.RELAY_AUTH_TOKEN = "";
  assert.equal((await fetch(post(), f2.env)).status, 503);
  const f3 = fixture();
  f3.env.RELAY_AUTH_TOKEN = "token with spaces";
  assert.equal((await fetch(post(), f3.env)).status, 503);
  assert.deepEqual(f.order, []);
});
