export type Values = Record<string, string>;
export type Secrets = Record<string, string | null>;
export interface Snapshot {
  values: Values;
  secrets: Record<string, boolean>;
  revision: string;
  file: string;
  exists: boolean;
  csrfToken: string;
}
export interface Draft { values: Values; secrets: Secrets; revision: string }
export interface Validation { valid: boolean; errors: Record<string, string>; warnings?: Record<string, string> }
export type Tab = 'github' | 'triggers' | 'runtime' | 'tools' | 'observability';
export type Page = Tab | 'setup' | 'runs';
export const tabs: { id: Tab; label: string }[] = [
  { id: 'github', label: 'GitHub' }, { id: 'triggers', label: 'Triggers' },
  { id: 'runtime', label: 'Model & runtime' }, { id: 'tools', label: 'Tools' },
  { id: 'observability', label: 'Observability' },
];
export const fieldLabels: Record<string, string> = {
  GITHUB_REPOSITORY: 'Repository', BASE_REF: 'Base branch', REPOSITORY_PATH: 'Local checkout',
  GITHUB_APP_CLIENT_ID: 'Client ID', GITHUB_APP_PRIVATE_KEY_PATH: 'Private key path',
  GITHUB_APP_INSTALLATION_ID: 'Installation ID', GITHUB_TOKEN: 'GitHub token',
  GITHUB_WEBHOOK_SECRET: 'Webhook secret', GITHUB_FEEDBACK: 'GitHub feedback',
  GITHUB_EVENT_SOURCE: 'Event source', GITHUB_POLL_INTERVAL_MS: 'GitHub poll interval',
  GITHUB_SERVER_URL: 'GitHub server URL', GITHUB_API_URL: 'GitHub API URL',
  MODEL_PROVIDER: 'Provider', MODEL: 'Model ID', MODEL_API_KEY: 'Model API key',
  MODEL_BASE_URL: 'API base URL', CONCURRENCY: 'Concurrent runs', MAX_STEPS: 'Bash calls per run',
  RUN_TIMEOUT_MS: 'Run timeout', MAX_ATTEMPTS: 'Maximum attempts', LEASE_MS: 'Lease duration',
  DATA_DIR: 'Data directory', HOST: 'Webhook bind address', PORT: 'Webhook port',
  ISSUE_ACTIONS: 'Issue events', ISSUE_LABELS: 'Required labels', ISSUE_AUTHORS: 'Issue authors',
  BOT_LOGINS: 'Bot logins', COMMENT_PREFIX: 'Comment command', EXTENSIONS: 'Extension module',
  ASCIINEMA_ENABLED: 'Terminal recordings', ASCIINEMA_COLS: 'Terminal columns',
  ASCIINEMA_ROWS: 'Terminal rows', ASCIINEMA_MAX_BYTES: 'Recording size limit',
  CLOUDFLARE_RELAY_URL: 'Relay URL', CLOUDFLARE_ACCOUNT_ID: 'Cloudflare account ID',
  CLOUDFLARE_QUEUE_ID: 'Cloudflare queue ID', CLOUDFLARE_API_TOKEN: 'Cloudflare API token',
  CLOUDFLARE_RELAY_TOKEN: 'Relay access token', CLOUDFLARE_POLL_INTERVAL_MS: 'Poll interval',
};
export function tabForField(key: string): Tab {
  if (key.startsWith('ASCIINEMA_')) return 'observability';
  if (key.startsWith('ISSUE_') || ['BOT_LOGINS', 'COMMENT_PREFIX'].includes(key)) return 'triggers';
  if (key === 'EXTENSIONS') return 'tools';
  if (key.startsWith('CLOUDFLARE_')) return 'github';
  if (key.startsWith('GITHUB_') || ['BASE_REF', 'REPOSITORY_PATH'].includes(key)) return 'github';
  return 'runtime';
}
export function hasSecret(snapshot: Snapshot, secrets: Secrets, key: string) {
  return key in secrets ? Boolean(secrets[key]) : Boolean(snapshot.secrets[key]);
}
export function setupItems(values: Values, snapshot: Snapshot, secrets: Secrets) {
  const app = Boolean(values.GITHUB_APP_CLIENT_ID?.trim() && values.GITHUB_APP_PRIVATE_KEY_PATH?.trim());
  const polling = values.GITHUB_EVENT_SOURCE === 'poll';
  const optionalAuth = values.GITHUB_FEEDBACK === 'false' && !polling;
  return [
    { label: 'Choose a repository', detail: 'Where your agent will work', tab: 'github' as Tab,
      complete: /^[^\s/]+\/[^\s/]+$/.test(values.GITHUB_REPOSITORY ?? '') },
    { label: optionalAuth ? 'GitHub credentials · optional' : 'Add GitHub credentials', detail: optionalAuth ? 'Private repositories still need access' : 'App credentials or a token', tab: 'github' as Tab,
      optional: optionalAuth, complete: app || hasSecret(snapshot, secrets, 'GITHUB_TOKEN') },
    { label: polling ? 'GitHub API polling selected' : 'Secure your webhook',
      detail: polling ? 'No public webhook required' : 'Authenticate incoming issues', tab: 'github' as Tab,
      complete: polling || hasSecret(snapshot, secrets, 'GITHUB_WEBHOOK_SECRET') },
    { label: 'Configure a model', detail: values.EXTENSIONS ? 'Custom adapters need a startup check' : 'Bring your model and API key', tab: 'runtime' as Tab,
      complete: Boolean(values.MODEL && (values.MODEL_PROVIDER === 'openai-compatible'
        ? values.MODEL_BASE_URL : hasSecret(snapshot, secrets, 'MODEL_API_KEY') || snapshot.secrets.ANTHROPIC_API_KEY)) },
  ];
}
export function redactedEnvironment(values: Values, snapshot: Snapshot, secrets: Secrets) {
  const quote = (value: string) => JSON.stringify(value);
  const lines = Object.entries(values).filter(([key, value]) => value || ['COMMENT_PREFIX', 'ISSUE_ACTIONS'].includes(key))
    .map(([key, value]) => `${key}=${quote(value)}`);
  for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'MODEL_API_KEY', 'ANTHROPIC_API_KEY',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_RELAY_TOKEN']) {
    if (hasSecret(snapshot, secrets, key)) lines.push(`${key}=<redacted>`);
  }
  return ['# Redacted preview. Saved secrets are never sent to this browser.', '# Display values use JSON quoting. Save writes Node-compatible .env syntax.', '', ...lines].join('\n');
}
