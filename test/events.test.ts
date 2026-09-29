import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesFilters, normalizeEvent } from '../src/events.js';

const issue = {
  number: 42,
  title: 'Add a thing',
  body: 'Please add a thing',
  html_url: 'https://github.com/acme/widgets/issues/42',
  user: { login: 'Alice', type: 'User' },
  labels: [{ name: 'enhancement' }, { name: 'priority: high' }],
};
const repository = { full_name: 'acme/widgets' };

function webhook(eventName: string, action: string, overrides: Record<string, unknown> = {}) {
  return normalizeEvent(eventName, { action, issue, repository, ...overrides });
}

test('normalizes supported issue actions and preserves normalized issue data', () => {
  const event = webhook('issues', 'opened');
  assert.deepEqual(event, {
    repository: 'acme/widgets', issueNumber: 42, title: 'Add a thing', body: 'Please add a thing',
    author: 'Alice', labels: ['enhancement', 'priority: high'], action: 'opened', kind: 'issue',
    url: 'https://github.com/acme/widgets/issues/42',
  });
  assert.equal(webhook('issues', 'reopened')?.action, 'reopened');
  assert.equal(webhook('issues', 'labeled')?.action, 'labeled');
  assert.equal(webhook('issues', 'closed'), null);
});

test('allows explicit issue action configuration', () => {
  assert.equal(normalizeEvent('issues', { action: 'closed', issue, repository }, { issueActions: ['closed'] })?.action, 'closed');
});

test('normalizes created issue comments and requires the default command prefix in filters', () => {
  const event = webhook('issue_comment', 'created', {
    comment: { id: 7, body: '/agent please inspect', user: { login: 'Bob', type: 'User' } },
  });
  assert.equal(event?.kind, 'comment');
  assert.deepEqual(event?.comment, { id: 7, body: '/agent please inspect', author: 'Bob' });
  assert.equal(matchesFilters(event!), true);
  assert.equal(matchesFilters({ ...event!, comment: { ...event!.comment!, body: 'ordinary comment' } }), false);
  assert.equal(matchesFilters({ ...event!, comment: { ...event!.comment!, body: 'ordinary comment' } }, { commentPrefix: '' }), true);
});

test('accepts bot-authored issue events by default and permits explicit bot filters', () => {
  const botIssue = {
    ...issue,
    user: { login: 'dependabot[bot]', type: 'Bot' },
  };
  const payload = { action: 'opened', issue: botIssue, repository };
  const event = normalizeEvent('issues', payload);
  assert.equal(event?.author, 'dependabot[bot]');
  assert.equal(matchesFilters(event!, { authors: ['dependabot[bot]'] }), true);
  assert.equal(matchesFilters(event!, { botLogins: ['dependabot[bot]'] }), false);
  assert.equal(normalizeEvent('issues', { ...payload, sender: { login: 'my-service', type: 'User' } },
    { botLogins: ['my-service'] }), null);
});

test('allows a human comment on a bot-authored issue but excludes bot comment actors', () => {
  const payload = {
    action: 'created', issue: { ...issue, user: { login: 'dependabot[bot]', type: 'Bot' } },
    repository,
    comment: { id: 99, body: '/agent investigate', user: { login: 'Alice', type: 'User' } },
    sender: { login: 'Alice', type: 'User' },
  };
  assert.equal(normalizeEvent('issue_comment', payload)?.kind, 'comment');
  assert.equal(normalizeEvent('issue_comment', { ...payload, sender: { login: 'a-bot', type: 'Bot' } }), null);
});

test('does not normalize issue comments that are edits, deletes, bot comments, or agent output', () => {
  const comment = { id: 7, body: '/agent go', user: { login: 'Bob', type: 'User' } };
  assert.equal(webhook('issue_comment', 'edited', { comment }), null);
  assert.equal(webhook('issue_comment', 'deleted', { comment }), null);
  assert.equal(webhook('issue_comment', 'created', { comment: { ...comment, user: { login: 'dependabot[bot]', type: 'Bot' } } }), null);
  assert.equal(webhook('issue_comment', 'created', { comment: { ...comment, body: '<!-- just-bash-agent: v1 --> response' } }), null);
  const ordinaryComment = webhook('issue_comment', 'created', { comment: { ...comment, body: 'ordinary comment' } });
  assert.ok(ordinaryComment);
  assert.equal(matchesFilters(ordinaryComment), false);
});

test('ignores pull requests and malformed payloads without throwing', () => {
  assert.equal(webhook('issues', 'opened', { issue: { ...issue, pull_request: { url: 'https://api.github.com/pulls/42' } } }), null);
  assert.equal(normalizeEvent('issues', null), null);
  assert.equal(normalizeEvent('issues', { action: 'opened', issue: { ...issue, number: '42' } }), null);
  assert.equal(normalizeEvent('issues', { action: 'opened', issue, repository: { full_name: 'bad' } }), null);
  assert.equal(normalizeEvent('issues', { action: 'opened', issue, repository: { full_name: 'acme/..' } }), null);
  assert.equal(normalizeEvent('issues', { action: 'opened', issue }), null);
  assert.equal(normalizeEvent('issue_comment', { action: 'created', issue }), null);
});

test('applies label-all, issue-author, bot-login and issue-action filters', () => {
  const event = webhook('issues', 'opened')!;
  assert.equal(matchesFilters(event, { labels: ['enhancement', 'priority: HIGH'], authors: ['alice'] }), true);
  assert.equal(matchesFilters(event, { labels: ['enhancement', 'bug'] }), false);
  assert.equal(matchesFilters(event, { authors: ['Bob'] }), false);
  assert.equal(matchesFilters(event, { botLogins: ['ALICE'] }), false);
  assert.equal(matchesFilters(event, { issueActions: ['closed'] }), false);
});

test('matches comment command prefix and filters against issue author', () => {
  const event = webhook('issue_comment', 'created', {
    comment: { id: 8, body: '/run task', user: { login: 'Bob', type: 'User' } },
  })!;
  assert.equal(matchesFilters(event, { authors: ['alice'], commentPrefix: '/run' }), true);
  assert.equal(matchesFilters(event, { authors: ['bob'], commentPrefix: '/run' }), false);
  assert.equal(matchesFilters(event, { authors: ['alice'], commentPrefix: '/agent' }), false);
});
