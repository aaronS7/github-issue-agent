import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';

function repositoryParts(repository) {
  if (typeof repository !== 'string') throw new Error('Invalid GITHUB_REPOSITORY');
  const parts = repository.split('/');
  if (parts.length !== 2) throw new Error('Invalid GITHUB_REPOSITORY');
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid GITHUB_REPOSITORY');
  }
  return { owner, name };
}

function apiBase(apiUrl) {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GITHUB_API_URL must be a plain HTTPS URL');
  }
  return url.href.replace(/\/$/, '');
}

function makeJwt(clientId, privateKey, nowSeconds) {
  let key;
  try { key = createPrivateKey(privateKey); }
  catch { throw new Error('Invalid GitHub App private key'); }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App private key must be RSA');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: clientId,
  })).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

/** Mint one repository-scoped GitHub App installation token. This example does not refresh it. */
export async function mintInstallationToken(
  { clientId, privateKey, repository, apiUrl = 'https://api.github.com' },
  { fetch: fetchImpl = globalThis.fetch, now = Date.now } = {},
) {
  if (typeof clientId !== 'string' || !clientId.trim() ||
      typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new Error('GitHub App client ID and private key are required');
  }
  const { owner, name } = repositoryParts(repository);
  const base = apiBase(apiUrl);
  const nowSeconds = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new Error('Invalid current time');
  const jwt = makeJwt(clientId, privateKey, nowSeconds);
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${jwt}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'just-bash-issue-agent-token-example',
  };

  async function request(path, method, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`GitHub App ${method} request failed`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub App ${method} request failed (HTTP ${response.status})`);
    }
    try { return await response.json(); }
    catch { throw new Error(`GitHub App ${method} returned invalid JSON`); }
  }

  const installation = await request(`/repos/${owner}/${name}/installation`, 'GET');
  const installationId = installation?.id;
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GitHub returned an invalid installation ID');
  }
  const issued = await request(`/app/installations/${installationId}/access_tokens`, 'POST', {
    repositories: [name],
    permissions: { contents: 'read', issues: 'write' },
  });
  if (typeof issued?.token !== 'string' || !issued.token || /\s/.test(issued.token) ||
      typeof issued.expires_at !== 'string' || Number.isNaN(Date.parse(issued.expires_at))) {
    throw new Error('GitHub returned an invalid installation token response');
  }
  return { token: issued.token, expiresAt: issued.expires_at, installationId };
}

async function main() {
  const { GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    GITHUB_REPOSITORY: repository, GITHUB_API_URL: apiUrl } = process.env;
  if (!clientId || !keyPath || !repository) {
    throw new Error('Set GITHUB_APP_CLIENT_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_REPOSITORY');
  }
  const privateKey = await readFile(keyPath, 'utf8');
  const result = await mintInstallationToken({ clientId, privateKey, repository,
    ...(apiUrl ? { apiUrl } : {}) });
  process.stderr.write(`Installation ${result.installationId}; token expires ${result.expiresAt}\n`);
  process.stdout.write(`${result.token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Could not mint GitHub App token: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
