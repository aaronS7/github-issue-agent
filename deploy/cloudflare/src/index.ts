export interface WebhookEnvelope {
  version: 1;
  deliveryId: string;
  eventName: string;
  signature: string;
  bodySha256: string;
  objectKey: string;
}

export interface Env {
  GITHUB_REPOSITORY: string;
  GITHUB_WEBHOOK_SECRET: string;
  RELAY_AUTH_TOKEN: string;
  WEBHOOK_QUEUE: Queue<WebhookEnvelope>;
  WEBHOOK_PAYLOADS: R2Bucket;
}

const MAX_BODY_BYTES = 1_048_576;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;
const PAYLOAD_PATH = /^\/payload\/([A-Za-z0-9-]{1,128})\/([a-f0-9]{64})$/;
const encoder = new TextEncoder();

function configured(env: Partial<Env>): env is Env {
  return Boolean(
    typeof env.GITHUB_REPOSITORY === "string" &&
    REPOSITORY.test(env.GITHUB_REPOSITORY) &&
    env.GITHUB_REPOSITORY.toLowerCase() !== "change_me_owner/repo" &&
    typeof env.GITHUB_WEBHOOK_SECRET === "string" && env.GITHUB_WEBHOOK_SECRET.length > 0 &&
    typeof env.RELAY_AUTH_TOKEN === "string" && env.RELAY_AUTH_TOKEN.length > 0 && !/\s/.test(env.RELAY_AUTH_TOKEN) &&
    env.WEBHOOK_QUEUE && typeof env.WEBHOOK_QUEUE.send === "function" &&
    env.WEBHOOK_PAYLOADS && typeof env.WEBHOOK_PAYLOADS.put === "function" &&
    typeof env.WEBHOOK_PAYLOADS.get === "function"
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("Request body unavailable");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifySignature(secret: string, body: Uint8Array, signature: string): Promise<boolean> {
  const match = SIGNATURE.exec(signature);
  if (!match) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, unhex(match[1]), Uint8Array.from(body));
}

async function equalToken(actual: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function response(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function webhook(request: Request, env: Env): Promise<Response> {
  const deliveryId = request.headers.get("X-GitHub-Delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return response(400, "Invalid delivery ID");
  const length = request.headers.get("Content-Length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) return response(413, "Payload too large");
  const body = await readBounded(request.body);
  if (body === null) return response(413, "Payload too large");
  const signature = request.headers.get("X-Hub-Signature-256") ?? "";
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) return response(401, "Invalid signature");
  const eventName = request.headers.get("X-GitHub-Event") ?? "";
  if (eventName === "ping") return response(200, "OK");
  if (eventName !== "issues" && eventName !== "issue_comment") return response(202, "Ignored");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return response(400, "Invalid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response(400, "Invalid JSON");
  const repository = (payload as { repository?: { full_name?: unknown } }).repository?.full_name;
  if (typeof repository !== "string" || repository.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) {
    return response(202, "Ignored");
  }
  const bodySha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(body))));
  const objectKey = `github/${deliveryId}/${bodySha256}`;
  const envelope: WebhookEnvelope = { version: 1, deliveryId, eventName, signature, bodySha256, objectKey };
  try {
    await env.WEBHOOK_PAYLOADS.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
    await env.WEBHOOK_QUEUE.send(envelope, { contentType: "json" });
  } catch {
    return response(503, "Persistence unavailable");
  }
  return response(202, "Accepted");
}

async function payload(request: Request, env: Env, path: string): Promise<Response> {
  const match = PAYLOAD_PATH.exec(path);
  if (!match) return response(404, "Not found");
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !(await equalToken(token, env.RELAY_AUTH_TOKEN))) return response(401, "Unauthorized");
  try {
    const object = await env.WEBHOOK_PAYLOADS.get(`github/${match[1]}/${match[2]}`);
    if (!object) return response(404, "Not found");
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_BODY_BYTES) {
      return response(503, "Persistence unavailable");
    }
    return new Response(object.body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return response(503, "Persistence unavailable");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/webhooks/github") {
        if (!configured(env)) return response(503, "Service unavailable");
        return await webhook(request, env);
      }
      if (request.method === "GET" && path.startsWith("/payload/")) {
        if (!configured(env)) return response(503, "Service unavailable");
        return await payload(request, env, path);
      }
      return response(404, "Not found");
    } catch {
      return response(503, "Service unavailable");
    }
  }
};
