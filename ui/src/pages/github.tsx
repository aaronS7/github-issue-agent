import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, CircleDot, Info, KeyRound, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { GitHubIcon as Github } from '../components/icons';
import type { Configuration } from '../lib/use-configuration';
import { Button, Badge, CodeBlock, Notice, Section } from '../components/primitives';
import { Field, SecretField, SettingField } from '../components/fields';
import { hasSecret } from '../lib/configuration';
import { CloudflareRelaySettings } from '../components/cloudflare-relay-settings';

export function GitHubPage({ config }: { config: Configuration }) {
  const hasApp = Boolean(config.values.GITHUB_APP_CLIENT_ID || config.values.GITHUB_APP_PRIVATE_KEY_PATH || config.values.GITHUB_APP_INSTALLATION_ID);
  const polling = config.values.GITHUB_EVENT_SOURCE === 'poll';
  const [modeOverride, setMode] = useState<'app' | 'token' | null>(null);
  useEffect(() => { if (!config.dirty) setMode(null); }, [config.dirty, config.snapshot?.revision]);
  const tokenChosen = hasSecret(config.snapshot!, config.secrets, 'GITHUB_TOKEN') || config.secrets.GITHUB_TOKEN === null;
  const mode = modeOverride ?? (hasApp || !tokenChosen ? 'app' : 'token');
  const [connection, setConnection] = useState<{ ok: boolean; message: string; fingerprint: string } | null>(null);
  const fingerprint = JSON.stringify([config.values, config.secrets]);
  const currentConnection = connection?.fingerprint === fingerprint ? connection : null;
  let webhookUrl = 'https://your-domain.com/webhooks/github';
  try {
    const relay = new URL(config.values.CLOUDFLARE_RELAY_URL ?? '');
    if (relay.protocol === 'https:' && !relay.username && !relay.password &&
        relay.pathname === '/' && !relay.search && !relay.hash) webhookUrl = `${relay.origin}/webhooks/github`;
  } catch { /* Use the direct webhook example while the relay origin is incomplete. */ }
  const changeMode = (next: 'app' | 'token') => {
    setMode(next);
    if (next === 'token') for (const key of ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID']) config.setValue(key, '');
  };
  const generateSecret = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    config.setSecret('GITHUB_WEBHOOK_SECRET', [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''));
  };
  return <>
    <Section title="Repository" description="Give your agent a place to work." action={<span className="section-icon"><Github size={18} /></span>}>
      <div className="field-grid field-grid--repository"><SettingField config={config} name="GITHUB_REPOSITORY" placeholder="your-org/your-repository" hint="The repository where issues will trigger runs." />
        <SettingField config={config} name="BASE_REF" placeholder="HEAD" hint="HEAD uses the default branch." /></div>
      <details className="disclosure"><summary>Use an existing local checkout</summary><SettingField config={config} name="REPOSITORY_PATH" placeholder="/path/to/repository" hint="Leave empty to clone from GitHub. Only committed files are used." optional /></details>
    </Section>
    <Section title="Authentication" description="Connect your bot to GitHub." action={<Badge dot tone={currentConnection?.ok ? 'success' : 'neutral'}>{currentConnection?.ok ? 'Access verified' : 'Not verified'}</Badge>}
      footer={<><div className="footer-caption"><ShieldCheck size={14} /><span>Credentials stay on this machine.</span></div><Button busy={config.busy === 'github'} onClick={async () => {
        try { const result = await config.checkGitHub(); setConnection({ ...result, fingerprint }); }
        catch (e) { setConnection({ ok: false, message: e instanceof Error ? e.message : 'Connection check failed.', fingerprint }); }
      }}><RefreshCw size={13} />Test connection</Button></>}>
      <div className="auth-options" role="radiogroup" aria-label="Authentication method">
        <label className={`auth-option ${mode === 'app' ? 'selected' : ''}`}><input type="radio" name="auth-mode" value="app" aria-label="GitHub App" checked={mode === 'app'} onChange={() => changeMode('app')} /><Github size={17} /><span>GitHub App</span><Badge>Recommended</Badge><span className="radio-indicator">{mode === 'app' && <Check size={9} />}</span></label>
        <label className={`auth-option ${mode === 'token' ? 'selected' : ''}`}><input type="radio" name="auth-mode" value="token" checked={mode === 'token'} onChange={() => changeMode('token')} /><KeyRound size={17} /><span>Access token</span><span className="radio-indicator">{mode === 'token' && <Check size={9} />}</span></label>
      </div>
      {mode === 'app' ? <div className="stack"><div className="field-grid"><SettingField config={config} name="GITHUB_APP_CLIENT_ID" placeholder="Iv23li…" hint="Found in your GitHub App’s settings." />
        <SettingField config={config} name="GITHUB_APP_INSTALLATION_ID" placeholder="Auto-detect" inputMode="numeric" hint="Discovered from your repository if empty." optional /></div>
        <SettingField config={config} name="GITHUB_APP_PRIVATE_KEY_PATH" placeholder="/absolute/path/to/github-app.pem" hint="Path to the PEM file on the machine running your bot." />
        <div className="inline-note"><RefreshCw size={14} /><span>Installation tokens renew automatically before expiry.</span></div>
        {hasSecret(config.snapshot!, config.secrets, 'GITHUB_TOKEN') && <p className="field-hint">Saved access token retained as a fallback. Complete App credentials take precedence.</p>}
      </div> : <SecretField config={config} name="GITHUB_TOKEN" hint="Requires Contents: read, Issues: read for polling, and Issues: write for feedback. Static tokens must be renewed manually." />}
      {currentConnection && <Notice tone={currentConnection.ok ? 'success' : 'error'} role="status">{currentConnection.ok ? <Check size={16} /> : <Info size={16} />}<span>{currentConnection.message}</span></Notice>}
    </Section>
    <Section title="Event source" description="Choose how your agent discovers work." action={<CircleDot size={18} className="muted" />}>
      <Field id="GITHUB_EVENT_SOURCE" label="Event source" error={config.errors.GITHUB_EVENT_SOURCE}>
        <select id="GITHUB_EVENT_SOURCE" className="input" value={config.values.GITHUB_EVENT_SOURCE || 'webhook'}
          onChange={event => config.setValue('GITHUB_EVENT_SOURCE', event.target.value)}>
          <option value="webhook">GitHub webhooks</option><option value="poll">Poll the GitHub API</option>
        </select>
      </Field>
      {polling ? <div className="stack">
        <SettingField config={config} name="GITHUB_POLL_INTERVAL_MS" type="number" min={10000} max={3600000} step={1000}
          hint="Milliseconds between checks. 60000 is one minute. GitHub rate limits can delay the next check." />
        <p className="field-hint">Uses outbound requests with your App or token. No public endpoint or webhook secret is needed. Disable webhook delivery in your GitHub App for a polling-only setup.</p>
        <p className="field-hint">Starts with issues updated after first activation. Each eligible open issue runs once; new matching comments request follow-ups. Saved progress survives restarts.</p>
      </div> : <>
      <SecretField config={config} name="GITHUB_WEBHOOK_SECRET" hint="Use the same secret in your GitHub App’s webhook settings. Copy a generated secret before saving; saved values stay hidden."
        action={<Button variant="ghost" onClick={generateSecret}><Sparkles size={12} />Generate secret</Button>} />
      {config.secrets.GITHUB_WEBHOOK_SECRET && <CodeBlock label="Copy the new secret into GitHub before saving" value={config.secrets.GITHUB_WEBHOOK_SECRET} />}
      <CodeBlock label="Webhook endpoint · use your public HTTPS domain" value={webhookUrl} />
      <div className="webhook-events"><span>Subscribe to</span><code>Issues</code><code>Issue comments</code></div>
      <a href="#setup" className="text-link">GitHub App setup guide<ArrowUpRight size={13} /></a>
      <CloudflareRelaySettings config={config} />
      </>}
    </Section>
    <details className="section advanced-section"><summary>GitHub Enterprise<span>Custom endpoints</span></summary><div className="section-body stack">
      <SettingField config={config} name="GITHUB_SERVER_URL" type="url" placeholder="https://github.com" />
      <SettingField config={config} name="GITHUB_API_URL" type="url" placeholder="https://api.github.com" />
    </div></details>
  </>;
}
