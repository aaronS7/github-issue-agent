import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { matchesFilters } from '../src/events.js';

const base = { GITHUB_REPOSITORY: 'Owner/Repo', GITHUB_WEBHOOK_SECRET: 'test-secret' };
const app = { GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_PRIVATE_KEY_PATH: './private/app.pem' };

test('poll mode needs authentication but no webhook secret and validates its interval', () => {
  const env = { GITHUB_REPOSITORY: 'Owner/Repo', GITHUB_EVENT_SOURCE: 'poll', GITHUB_TOKEN: 'fixture', GITHUB_FEEDBACK: 'false' };
  const config = loadConfig(env);
  assert.equal(config.eventSource, 'poll');
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.webhookSecret, '');
  assert.throws(() => loadConfig({ ...env, GITHUB_TOKEN: '' }), /polling requires/);
  assert.throws(() => loadConfig({ ...env, GITHUB_EVENT_SOURCE: 'other' }), /GITHUB_EVENT_SOURCE/);
  for (const interval of ['0', '10000', '14999', '3600001', '15000.5', 'invalid']) {
    assert.throws(() => loadConfig({ ...env, GITHUB_POLL_INTERVAL_MS: interval }), /GITHUB_POLL_INTERVAL_MS/);
  }
  assert.equal(loadConfig({ ...env, GITHUB_POLL_INTERVAL_MS: '15000' }).pollIntervalMs, 15_000);
  assert.equal(loadConfig({ ...base, GITHUB_FEEDBACK: 'false' }).eventSource, 'webhook');
  assert.throws(() => loadConfig({ ...env, GITHUB_EVENT_SOURCE: 'webhook' }), /GITHUB_WEBHOOK_SECRET/);
});

test('empty optional CSV filters allow any author while empty issue actions still disable issue triggers', () => {
  const config = loadConfig({ ...base, GITHUB_FEEDBACK: 'false', ISSUE_AUTHORS: ' , ', ISSUE_LABELS: '', BOT_LOGINS: '' });
  assert.equal(matchesFilters({ repository: 'owner/repo', issueNumber: 1, kind: 'issue', action: 'opened',
    author: 'alice', title: 'Test', body: '', labels: [], url: 'https://github.com/owner/repo/issues/1' }, config.filters), true);
  assert.deepEqual(loadConfig({ ...base, GITHUB_FEEDBACK: 'false', ISSUE_ACTIONS: '' }).filters.issueActions, []);
});

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
