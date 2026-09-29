import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { ConfigConflictError, ConfigInputError, ConfigStore, validateFields } from '../src/control-config.js';

test('configuration saves atomically, preserves unknown lines, and never returns secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-control-'));
  const path = join(directory, '.env');
  await writeFile(path, '# Keep this note\nUNKNOWN=keep\nGITHUB_TOKEN=old\nGITHUB_TOKEN=stale\nMODEL_API_KEY="line1\nline2"\n', 'utf8');
  const store = new ConfigStore(path);
  const initial = await store.snapshot('csrf');
  assert.equal(initial.values.GITHUB_REPOSITORY, '');
  assert.equal(initial.secrets.GITHUB_TOKEN, true);
  assert.equal(JSON.stringify(initial).includes('old'), false);
  assert.equal(JSON.stringify(initial).includes('line1'), false);
  const next = await store.save({ revision: initial.revision,
    values: { GITHUB_REPOSITORY: 'owner/repo', COMMENT_PREFIX: '', ISSUE_ACTIONS: '', ISSUE_LABELS: '' },
    secrets: { GITHUB_TOKEN: null, GITHUB_WEBHOOK_SECRET: 'line1\n$(touch /tmp/nope)' },
  }, 'csrf');
  const raw = await readFile(path, 'utf8');
  const parsed = parseEnv(raw);
  assert.match(raw, /# Keep this note\nUNKNOWN=keep/);
  assert.equal((raw.match(/^GITHUB_TOKEN=/gm) ?? []).length, 0);
  assert.equal(parsed.GITHUB_WEBHOOK_SECRET, 'line1\n$(touch /tmp/nope)');
  assert.equal(parsed.COMMENT_PREFIX, '');
  assert.equal(parsed.ISSUE_ACTIONS, '');
  assert.equal(parsed.ISSUE_LABELS, undefined);
  assert.equal(parsed.MODEL_API_KEY, 'line1\nline2');
  assert.equal((raw.match(/line2/g) ?? []).length, 1);
  assert.equal(next.secrets.GITHUB_TOKEN, false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(store.save({ revision: initial.revision, values: {}, secrets: {} }, 'csrf'), ConfigConflictError);
});

test('draft validation rejects malformed fields and checks readiness separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-control-'));
  const store = new ConfigStore(join(directory, '.env'));
  const initial = await store.snapshot('csrf');
  await assert.rejects(store.save({ revision: initial.revision,
    values: { GITHUB_REPOSITORY: 'bad repo', CONCURRENCY: '0' }, secrets: {},
  }, 'csrf'), ConfigInputError);
  const draft = await store.save({ revision: initial.revision,
    values: { GITHUB_REPOSITORY: 'owner/repo', MODEL_PROVIDER: 'anthropic' }, secrets: {},
  }, 'csrf');
  assert.equal(draft.values.GITHUB_REPOSITORY, 'owner/repo');
  const errors = validateFields(await store.draftEnv({ values: {}, secrets: {} }), true);
  assert.equal(errors.GITHUB_WEBHOOK_SECRET, 'Enter a webhook secret');
  assert.equal(errors.MODEL, 'Enter a model ID');
  assert.equal(errors.GITHUB_TOKEN, 'Enter GitHub App credentials or a GitHub token, or disable feedback');
  const normalized = await store.draftEnv({ values: { BASE_REF: '', MODEL_PROVIDER: '',
    ISSUE_LABELS: '', ISSUE_ACTIONS: '', COMMENT_PREFIX: '' }, secrets: {} });
  assert.equal(normalized.BASE_REF, undefined);
  assert.equal(normalized.MODEL_PROVIDER, undefined);
  assert.equal(normalized.ISSUE_LABELS, undefined);
  assert.equal(normalized.ISSUE_ACTIONS, '');
  assert.equal(normalized.COMMENT_PREFIX, '');
  const openai = validateFields({ GITHUB_REPOSITORY: 'owner/repo', GITHUB_WEBHOOK_SECRET: 'secret',
    GITHUB_TOKEN: 'token', MODEL_PROVIDER: 'openai-compatible', MODEL: 'local-model',
    MODEL_BASE_URL: 'http://localhost:8080/v1' }, true);
  assert.deepEqual(openai, {});
  const aggregate = validateFields({ GITHUB_REPOSITORY: 'invalid repo', CONCURRENCY: '0' }, true);
  assert.ok(aggregate.GITHUB_REPOSITORY);
  assert.ok(aggregate.CONCURRENCY);
  assert.ok(aggregate.GITHUB_WEBHOOK_SECRET);
  assert.ok(aggregate.MODEL);
  assert.ok(aggregate.GITHUB_TOKEN);
  const partialApp = validateFields({ GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_WEBHOOK_SECRET: 'secret', GITHUB_APP_CLIENT_ID: 'Iv1.example',
    GITHUB_TOKEN: 'fallback-token', EXTENSIONS: './extension.mjs' }, true);
  assert.equal(partialApp.GITHUB_APP_PRIVATE_KEY_PATH, 'Enter the GitHub App private key path');
  assert.equal(partialApp.form, undefined);
});

test('concurrent saves use the revision, and legacy Anthropic key has its own presence flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-control-'));
  const path = join(directory, '.env');
  await writeFile(path, '# Existing note\nUNKNOWN="first\nGITHUB_TOKEN=inside-unknown\nthird"\nANTHROPIC_API_KEY=legacy-secret\n', 'utf8');
  const store = new ConfigStore(path);
  const initial = await store.snapshot('csrf');
  assert.equal(initial.secrets.MODEL_API_KEY, false);
  assert.equal(initial.secrets.ANTHROPIC_API_KEY, true);
  assert.equal(JSON.stringify(initial).includes('legacy-secret'), false);
  const attempts = await Promise.allSettled([
    store.save({ revision: initial.revision, values: { MODEL: 'first' }, secrets: {} }, 'csrf'),
    store.save({ revision: initial.revision, values: { MODEL: 'second' }, secrets: {} }, 'csrf'),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected' &&
    attempt.reason instanceof ConfigConflictError).length, 1);
  const raw = await readFile(path, 'utf8');
  assert.match(raw, /# Existing note\nUNKNOWN="first\nGITHUB_TOKEN=inside-unknown\nthird"/);
  assert.equal(parseEnv(raw).ANTHROPIC_API_KEY, 'legacy-secret');
  assert.equal(parseEnv(raw).GITHUB_TOKEN, undefined);
});
