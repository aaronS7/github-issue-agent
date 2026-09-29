import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { GITHUB_REPOSITORY: 'Owner/Repo', GITHUB_WEBHOOK_SECRET: 'test-secret' };
const app = { GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_PRIVATE_KEY_PATH: './private/app.pem' };

test('App configuration enables feedback without a static token and takes precedence', () => {
  const config = loadConfig({ ...base, ...app, GITHUB_TOKEN: 'expired-static-token' });
  assert.deepEqual(config.githubApp, {
    clientId: 'Iv1.test', privateKeyPath: resolve('./private/app.pem'),
  });
  assert.equal(config.githubToken, undefined);
  assert.equal(config.feedback, true);
  assert.deepEqual(Object.keys(config.repositories), ['owner/repo']);
  assert.equal(loadConfig({ ...base, ...app, GITHUB_APP_INSTALLATION_ID: '123' })
    .githubApp?.installationId, 123);
});

test('static-token and unauthenticated configurations remain supported', () => {
  const config = loadConfig({ ...base, GITHUB_TOKEN: 'static-token' });
  assert.equal(config.githubToken, 'static-token');
  assert.equal(config.githubApp, undefined);
  assert.equal(loadConfig({ ...base, GITHUB_FEEDBACK: 'false' }).githubToken, undefined);
  assert.throws(() => loadConfig(base), /GitHub App credentials, GITHUB_TOKEN/);
});

test('partial App configuration fails instead of silently using a static token', () => {
  for (const partial of [
    { GITHUB_APP_CLIENT_ID: app.GITHUB_APP_CLIENT_ID },
    { GITHUB_APP_PRIVATE_KEY_PATH: app.GITHUB_APP_PRIVATE_KEY_PATH },
    { GITHUB_APP_INSTALLATION_ID: '123' },
    { ...app, GITHUB_APP_CLIENT_ID: ' ' },
  ]) {
    assert.throws(() => loadConfig({ ...base, ...partial, GITHUB_TOKEN: 'fallback' }),
      /Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_PATH/);
  }
  for (const installationId of ['0', '-1', '1.5', 'nope', '9007199254740992']) {
    assert.throws(() => loadConfig({ ...base, ...app, GITHUB_APP_INSTALLATION_ID: installationId }),
      /Invalid GITHUB_APP_INSTALLATION_ID/);
  }
});
