import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { ConfigConflictError, ConfigInputError, ConfigStore, parseDraft, validateFields } from './control-config.js';
import { GitHubAppAuth } from './github-auth.js';
import { InvalidRunReaderInputError, readRecording, readRun, readRuns } from './run-reader.js';

export interface ControlServerOptions {
  envPath?: string;
  uiDir?: string;
  allowedOrigins?: string[];
  /** Exact external HTTPS origin of a trusted reverse proxy. The listener stays on loopback. */
  publicUrl?: string;
  fetch?: typeof fetch;
}

const bodyLimit = 32 * 1024;
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function redactRunData(value: unknown, env: Record<string, string>): unknown {
  const secrets = ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'MODEL_API_KEY', 'ANTHROPIC_API_KEY',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_RELAY_TOKEN']
    .map(key => env[key]).filter((secret): secret is string => Boolean(secret)).sort((a, b) => b.length - a.length);
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), entry);
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => [visit(key), visit(item)]));
    return entry;
  };
  return visit(value);
}

function externalUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && /^https:\/\/[^/?#\\]+\/?$/i.test(value) &&
        !url.username && !url.password && !url.hostname.includes('*') &&
        url.pathname === '/' && !url.search && !url.hash) return url;
  } catch { /* Report a configuration error without echoing the supplied value. */ }
  throw new Error('UI public URL must be an HTTPS origin without credentials, a path, query, or fragment');
}

function safeHost(host: string | undefined, publicUrl?: URL): boolean {
  if (!host || /[\s/%@\\?#]/.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      Boolean(publicUrl && new URL(`https://${host}`).host === publicUrl.host);
  } catch { return false; }
}

function safeOrigin(req: IncomingMessage, allowedOrigins: ReadonlySet<string>, publicUrl?: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || origin !== url.origin) return false;
    return origin === publicUrl?.origin || allowedOrigins.has(origin) ||
      (safeHost(req.headers.host) && origin === `http://${req.headers.host}`);
  } catch { return false; }
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > bodyLimit) throw new ConfigInputError({ form: 'Request is too large' });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ConfigInputError({ form: 'Invalid JSON' }); }
}

function apiUrl(value: string | undefined): string {
  return (value || 'https://api.github.com').replace(/\/$/, '');
}

async function checkGitHub(env: Record<string, string>, fetchImpl: typeof fetch): Promise<{ ok: boolean; message: string }> {
  const errors = validateFields(env, true);
  for (const key of ['GITHUB_REPOSITORY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_INSTALLATION_ID', 'GITHUB_API_URL']) {
    if (errors[key]) return { ok: false, message: errors[key] };
  }
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) return { ok: false, message: 'Enter a repository first' };
  const app = Boolean(env.GITHUB_APP_CLIENT_ID || env.GITHUB_APP_PRIVATE_KEY_PATH || env.GITHUB_APP_INSTALLATION_ID);
  let token = env.GITHUB_TOKEN;
  if (app) {
    if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_PRIVATE_KEY_PATH) {
      return { ok: false, message: 'Enter both GitHub App client ID and private key path' };
    }
    try {
      const privateKey = await readFile(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
      const auth = new GitHubAppAuth({
        clientId: env.GITHUB_APP_CLIENT_ID, privateKey, repository,
        apiUrl: apiUrl(env.GITHUB_API_URL), feedback: env.GITHUB_FEEDBACK !== 'false',
        issuesRead: env.GITHUB_EVENT_SOURCE === 'poll',
        ...(env.GITHUB_APP_INSTALLATION_ID ? { installationId: Number(env.GITHUB_APP_INSTALLATION_ID) } : {}),
      }, { fetch: fetchImpl });
      token = await auth.getToken(AbortSignal.timeout(15_000));
    } catch { return { ok: false, message: 'GitHub App authentication failed; check the credentials and installation' }; }
  }
  if (!token) return { ok: false, message: 'Enter GitHub App credentials or a GitHub token' };
  try {
    const response = await fetchImpl(`${apiUrl(env.GITHUB_API_URL)}/repos/${repository}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'github-issue-agent' },
    });
    try { await response.body?.cancel(); } catch { /* Ignore close errors. */ }
    return response.ok ? { ok: true, message: 'GitHub repository read access verified' }
      : { ok: false, message: `GitHub repository check failed (HTTP ${response.status})` };
  } catch { return { ok: false, message: 'GitHub repository check failed' }; }
}

export function createControlServer(options: ControlServerOptions = {}): Server {
  const store = new ConfigStore(options.envPath);
  const csrfToken = randomBytes(32).toString('hex');
  const uiDir = resolve(options.uiDir ?? 'dist/ui');
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const publicUrl = externalUrl(options.publicUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const handle = async (): Promise<void> => {
      if (!safeHost(req.headers.host, publicUrl) || !safeOrigin(req, allowedOrigins, publicUrl)) {
        send(res, 403, { error: 'Forbidden origin' }); return;
      }
      let url: URL;
      try { url = new URL(req.url ?? '/', `http://${req.headers.host}`); }
      catch { send(res, 400, { error: 'Invalid URL' }); return; }
      const pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/config' && req.method === 'GET') {
          send(res, 200, await store.snapshot(csrfToken)); return;
        }
        if (req.method === 'GET' && (pathname === '/api/runs' || pathname.startsWith('/api/runs/'))) {
          const { env } = await store.current();
          const dataDir = resolve(env.DATA_DIR || 'data');
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
          if (pathname === '/api/runs') {
            const status = url.searchParams.get('status') || 'all';
            if (!['all', 'queued', 'running', 'done', 'dead'].includes(status)) {
              send(res, 400, { error: 'Invalid job status' }); return;
            }
            const result = await readRuns(dataDir, {
              status: status as 'all' | 'queued' | 'running' | 'done' | 'dead',
              ...(limit !== undefined ? { limit } : {}),
              ...(url.searchParams.has('before') ? { before: Number(url.searchParams.get('before')) } : {}),
            });
            send(res, 200, redactRunData(result, env)); return;
          }
          const match = /^\/api\/runs\/(\d+)(?:\/attempts\/([a-fA-F0-9-]+))?(\/(?:recording|events\.jsonl))?$/.exec(pathname);
          if (!match) { send(res, 404, { error: 'Run not found' }); return; }
          const jobId = Number(match[1]), runId = match[2];
          if (match[3] === '/events.jsonl') {
            if (!runId) { send(res, 404, { error: 'Run not found' }); return; }
            const lines: string[] = [];
            let cursor = 0;
            for (let batch = 0; batch < 22; batch++) {
              const detail = await readRun(dataDir, jobId, runId, { after: cursor, limit: 500 });
              if (!detail) { send(res, 404, { error: 'Run not found' }); return; }
              lines.push(...detail.events.map(event => JSON.stringify(redactRunData(event, env))));
              cursor = detail.nextCursor;
              if (!detail.hasMore) break;
              if (batch === 21) { send(res, 413, { error: 'Timeline exceeds the export limit; use the paginated API' }); return; }
            }
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="run-${jobId}-${runId}.jsonl"`);
            res.end(lines.length ? `${lines.join('\n')}\n` : ''); return;
          }
          if (match[3] === '/recording') {
            if (!runId) { send(res, 404, { error: 'Recording not found' }); return; }
            const recording = await readRecording(dataDir, jobId, runId);
            if (!recording) { send(res, 404, { error: 'Recording not found' }); return; }
            res.setHeader('Content-Type', 'application/x-asciicast; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${recording.filename}"`);
            res.setHeader('X-Recording-Partial', String(recording.partial));
            res.end(recording.bytes); return;
          }
          const detail = await readRun(dataDir, jobId, runId, {
            ...(limit !== undefined ? { limit } : {}),
            ...(url.searchParams.has('after') ? { after: Number(url.searchParams.get('after')) } : {}),
          });
          if (!detail) { send(res, 404, { error: 'Run not found' }); return; }
          send(res, 200, redactRunData(detail, env)); return;
        }
        if (!['PUT', 'POST'].includes(req.method ?? '')) {
          send(res, 405, { error: 'Method not allowed' }); return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
          send(res, 415, { error: 'Expected application/json' }); return;
        }
        if (req.headers['x-csrf-token'] !== csrfToken) {
          send(res, 403, { error: 'Invalid CSRF token' }); return;
        }
        const draft = parseDraft(await jsonBody(req));
        if (pathname === '/api/config' && req.method === 'PUT') {
          send(res, 200, await store.save(draft, csrfToken)); return;
        }
        const env = await store.draftEnv(draft);
        if (pathname === '/api/validate' && req.method === 'POST') {
          const errors = validateFields(env, true);
          const warnings: Record<string, string> = {};
          if (env.EXTENSIONS && (!env.MODEL ||
            ((env.MODEL_PROVIDER || 'anthropic') === 'anthropic' && !env.MODEL_API_KEY && !env.ANTHROPIC_API_KEY) ||
            (env.MODEL_PROVIDER === 'openai-compatible' && !env.MODEL_BASE_URL))) {
            warnings.EXTENSIONS = 'An extension must provide createModel when model settings are omitted';
          }
          send(res, 200, { valid: Object.keys(errors).length === 0, errors, warnings }); return;
        }
        if (pathname === '/api/github/check' && req.method === 'POST') {
          send(res, 200, await checkGitHub(env, fetchImpl)); return;
        }
        send(res, 404, { error: 'Not found' }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: 'Method not allowed' }); return;
      }
      const asset = pathname === '/' || pathname === '/setup' ? '/index.html' : pathname;
      let decoded: string;
      try { decoded = decodeURIComponent(asset); }
      catch { send(res, 400, { error: 'Invalid URL' }); return; }
      const file = resolve(uiDir, `.${decoded}`);
      const relativePath = relative(uiDir, file);
      if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || relativePath === '' ||
        relativePath.includes('\0')) { send(res, 404, { error: 'Not found' }); return; }
      let info;
      try {
        const actualRoot = await realpath(uiDir);
        const actualFile = await realpath(file);
        const actualRelative = relative(actualRoot, actualFile);
        if (actualRelative.startsWith(`..${sep}`) || actualRelative === '..' || actualRelative === '') {
          send(res, 404, { error: 'Not found' }); return;
        }
        info = await stat(actualFile);
      }
      catch { send(res, 404, { error: 'Not found' }); return; }
      if (!info.isFile()) { send(res, 404, { error: 'Not found' }); return; }
      res.statusCode = 200;
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Content-Length', info.size);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).on('error', () => { if (!res.headersSent) send(res, 500, { error: 'Unable to serve file' }); else res.destroy(); }).pipe(res);
    };
    void handle().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof ConfigConflictError) send(res, 409, { error: error.message });
      else if (error instanceof InvalidRunReaderInputError) send(res, 400, { error: 'Invalid run query' });
      else if (error instanceof ConfigInputError) send(res, 400, { error: error.message, errors: error.errors });
      else send(res, 500, { error: 'Internal error' });
    });
  });
}
