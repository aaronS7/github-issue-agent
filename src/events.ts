import { isRepositoryName } from './repository.js';

export interface IssueEvent {
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  action: string;
  kind: 'issue' | 'comment';
  comment?: { id: number; body: string; author: string };
  url: string;
}

export interface NormalizeEventOptions {
  /** Issue actions to normalize. Defaults to opened, reopened, and labeled. */
  issueActions?: string[];
  /** Additional bot logins to ignore, in addition to GitHub users with type Bot. */
  botLogins?: string[];
}

export interface EventFilters {
  /** Every configured label must be present on the issue. */
  labels?: string[];
  /** Match against the issue author's login. */
  authors?: string[];
  /** Comments must start with this prefix; defaults to `/agent`. */
  commentPrefix?: string;
  /** Additional bot logins to ignore. */
  botLogins?: string[];
  /** Restrict issue events to these actions. */
  issueActions?: string[];
}

const DEFAULT_ISSUE_ACTIONS = ['opened', 'reopened', 'labeled'];
const AGENT_COMMENT_MARKER = '<!-- just-bash-agent:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function githubLogin(value: unknown): string | null {
  if (!isRecord(value) || !nonEmptyString(value.login)) return null;
  return value.login;
}

function isBotUser(value: unknown, extraBotLogins: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'Bot') return true;
  const login = githubLogin(value);
  return login !== null && extraBotLogins.some((bot) => bot.toLowerCase() === login.toLowerCase());
}

function issueLabels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && nonEmptyString(entry)) {
      labels.push(entry);
      continue;
    }
    if (isRecord(entry) && nonEmptyString(entry.name)) {
      labels.push(entry.name);
      continue;
    }
    return null;
  }
  return labels;
}

function requiredIssueFields(issue: Record<string, unknown>, repositoryPayload: unknown): {
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  url: string;
} | null {
  const repositoryObject = repositoryPayload === undefined ? issue.repository : repositoryPayload;
  const repository = isRecord(repositoryObject) && isRepositoryName(repositoryObject.full_name)
    ? repositoryObject.full_name
    : null;
  const issueNumber = issue.number;
  const title = typeof issue.title === 'string' ? issue.title : null;
  const body = issue.body === null || issue.body === undefined
    ? ''
    : typeof issue.body === 'string' ? issue.body : null;
  const author = githubLogin(issue.user);
  const labels = issueLabels(issue.labels);
  const url = nonEmptyString(issue.html_url) ? issue.html_url : null;

  if (repository === null ||
      !positiveId(issueNumber) || title === null || body === null || author === null ||
      labels === null || url === null) return null;

  return { repository, issueNumber, title, body, author, labels, url };
}

/** Convert GitHub issue webhooks into a small validated event model. Pull requests are ignored. */
export function normalizeEvent(
  eventName: string,
  payload: unknown,
  options: NormalizeEventOptions = {},
): IssueEvent | null {
  if (!isRecord(payload) || !nonEmptyString(payload.action) || !isRecord(payload.issue)) return null;
  const action = payload.action;
  const issue = payload.issue;
  if (isRecord(issue.pull_request)) return null;

  const botLogins = options.botLogins ?? [];
  const isConfiguredBot = (value: unknown) => {
    const login = githubLogin(value);
    return login !== null && botLogins.some((bot) => bot.toLowerCase() === login.toLowerCase());
  };
  const fields = requiredIssueFields(issue, payload.repository);
  if (!fields) return null;

  if (eventName === 'issues') {
    if (isConfiguredBot(payload.sender)) return null;
    const allowedActions = options.issueActions ?? DEFAULT_ISSUE_ACTIONS;
    if (!allowedActions.includes(action)) return null;
    return { ...fields, action, kind: 'issue' };
  }

  if (eventName !== 'issue_comment' || action !== 'created' || !isRecord(payload.comment)) return null;
  const comment = payload.comment;
  if (isBotUser(payload.sender, botLogins)) return null;
  const commentBody = typeof comment.body === 'string' ? comment.body : null;
  const commentAuthor = githubLogin(comment.user);
  const commentId = comment.id;
  if (commentBody === null || !positiveId(commentId) || commentAuthor === null ||
      isBotUser(comment.user, botLogins) || commentBody.includes(AGENT_COMMENT_MARKER)) return null;

  return {
    ...fields,
    action,
    kind: 'comment',
    comment: { id: commentId, body: commentBody, author: commentAuthor },
  };
}

/** Apply repo-configurable filters after normalization. */
export function matchesFilters(event: IssueEvent, filters: EventFilters = {}): boolean {
  if (filters.issueActions && event.kind === 'issue' && !filters.issueActions.includes(event.action)) return false;

  const lower = (value: string): string => value.toLowerCase();
  if (filters.labels && !filters.labels.every((label) =>
    event.labels.some((actual) => lower(actual) === lower(label)))) return false;
  if (filters.authors && !filters.authors.some((author) => lower(author) === lower(event.author))) return false;

  if (filters.botLogins) {
    const logins = filters.botLogins.map(lower);
    if (logins.includes(lower(event.author)) ||
        (event.comment && logins.includes(lower(event.comment.author)))) return false;
  }

  if (event.kind === 'comment') {
    const prefix = filters.commentPrefix ?? '/agent';
    if (prefix.length > 0 && !event.comment?.body.startsWith(prefix)) return false;
  }
  return true;
}
