import { useEffect, useState } from 'react';
import { ArrowRight, Check, CheckCheck, CircleAlert, FileCode2, LoaderCircle, RotateCcw, Save, Terminal, X } from 'lucide-react';
import { Button, Badge, CopyButton, Dialog, Notice } from './components/primitives';
import { Shell } from './components/shell';
import { SetupChecklist } from './components/setup-checklist';
import { ApiError, useConfiguration } from './lib/use-configuration';
import { fieldLabels, redactedEnvironment, tabForField, tabs } from './lib/configuration';
import type { Page } from './lib/configuration';
import { GitHubPage } from './pages/github';
import { TriggersPage } from './pages/triggers';
import { RuntimePage } from './pages/runtime';
import { ToolsPage } from './pages/tools';
import { SetupPage } from './pages/setup';
import { ObservabilityPage } from './pages/observability';
import { RunsPage } from './pages/runs';

const readPage = (): Page => {
  const value = window.location.hash.slice(1).split('?')[0];
  return ['github', 'triggers', 'runtime', 'tools', 'setup', 'observability', 'runs'].includes(value) ? value as Page : 'github';
};
export function App() {
  const config = useConfiguration();
  const [page, setPage] = useState<Page>(readPage);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'neutral'; text: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const changed = () => { setPage(readPage()); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => { document.title = `${page === 'setup' ? 'Setup guide' : page === 'runs' ? 'Runs' : 'Configuration'} · just-bash`; }, [page]);
  const handleError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setConflict(true);
    if (e instanceof ApiError && e.errors) { const key = Object.keys(e.errors)[0]; if (key) window.location.hash = tabForField(key); }
    setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'The request failed. Try again.' });
  };
  const save = async () => {
    setMessage(null);
    try { await config.save(); setSaved(true); setConflict(false); setMessage({ tone: 'success', text: 'Configuration saved. Restart the bot to apply your changes.' }); }
    catch (e) { handleError(e); }
  };
  const validate = async () => {
    setMessage(null);
    try {
      const result = await config.validate();
      if (result.valid) setMessage(result.warnings && Object.keys(result.warnings).length
        ? { tone: 'neutral', text: `Basic settings are valid. ${Object.values(result.warnings).join(' ')} Model access and webhook delivery have not been tested.` }
        : { tone: 'success', text: 'Configuration looks valid. Save it, then start or restart the bot. Model access and webhook delivery have not been tested.' });
      else { const first = Object.keys(result.errors)[0]; if (first) window.location.hash = tabForField(first);
        setMessage({ tone: 'error', text: 'A few settings need your attention. Review the highlighted fields below.' }); }
    } catch (e) { handleError(e); }
  };
  const content = { github: <GitHubPage config={config} />, triggers: <TriggersPage config={config} />, runtime: <RuntimePage config={config} />, tools: <ToolsPage config={config} />, setup: <SetupPage config={config} />, observability: <ObservabilityPage config={config} /> };
  const environment = config.snapshot ? redactedEnvironment(config.values, config.snapshot, config.secrets) : '';
  return <Shell page={page} repository={config.values.GITHUB_REPOSITORY} onEnvironment={() => setEnvironmentOpen(true)}>
    <main id="main" className="main-content">
      {import.meta.env.VITE_CONSOLE_PREVIEW === 'true' && <div className="preview-banner"><span className="status-dot" />Preview workspace · saves to a temporary environment file</div>}
      <header className="page-header"><div><div className="eyebrow">YOUR GITHUB AGENT</div><h1>{page === 'setup' ? 'A small setup. A capable agent' : page === 'runs' ? 'Runs' : 'Configuration'}<span className="heading-period">.</span></h1><p>{page === 'setup' ? 'Everything you need to go from a repository to your first run.' : page === 'runs' ? 'Follow the work. Inspect each step. Replay the details.' : 'Your repository, your rules. Give your agent a place to start.'}</p></div>
        {page !== 'setup' && page !== 'runs' && <Button className="guide-button" onClick={() => { window.location.hash = 'setup'; }}>Setup guide<ArrowRight size={14} /></Button>}
      </header>
      {config.loading ? <div className="loading-state"><LoaderCircle className="spin" size={22} /><p>Loading your configuration…</p></div> : config.loadError ? <Notice tone="error"><CircleAlert size={18} /><div><strong>Couldn’t load the configuration</strong><p>{config.loadError}</p><Button onClick={() => void config.load()}>Try again</Button></div></Notice> : config.snapshot && <>
        {page === 'runs' ? <RunsPage dirty={config.dirty} /> : <>
        <div className="configuration-meta"><span><span className="project-mark"><Terminal size={13} /></span><strong>{config.values.GITHUB_REPOSITORY || 'New agent'}</strong><Badge dot tone={config.dirty ? 'warning' : 'neutral'}>{config.dirty ? 'Unsaved changes' : config.snapshot.exists ? 'Saved configuration' : 'Not configured'}</Badge></span><button type="button" onClick={() => setEnvironmentOpen(true)}><FileCode2 size={13} />Environment<ArrowRight size={12} /></button></div>
        {page !== 'setup' && <nav className="tabs" aria-label="Configuration sections">{tabs.map(tab => <a key={tab.id} href={`#${tab.id}`} className={page === tab.id ? 'tab tab--active' : 'tab'} aria-current={page === tab.id ? 'page' : undefined}>{tab.label}</a>)}</nav>}
        {message && <Notice tone={message.tone} role="status">{message.tone === 'error' ? <CircleAlert size={16} /> : <Check size={16} />}<div className="notice-content"><span>{message.text}</span>{conflict && <Button onClick={() => setDiscardOpen(true)}>Reload saved configuration</Button>}</div><button className="dismiss-button" type="button" aria-label="Dismiss notification" onClick={() => setMessage(null)}><X size={14} /></button></Notice>}
        {Object.keys(config.errors).length > 0 && <div className="validation-links" aria-label="Configuration errors">{Object.entries(config.errors).map(([key, error]) => <a href={`#${tabForField(key)}`} key={key} onClick={() => setTimeout(() => document.getElementById(key)?.focus(), 0)}>{fieldLabels[key] || key}: {error}</a>)}</div>}
        <div className={`configuration-layout ${page === 'setup' ? 'configuration-layout--guide' : ''}`}><fieldset className="configuration-form" disabled={Boolean(config.busy)} aria-label={page === 'setup' ? 'Setup guide' : 'Agent settings'}>{content[page]}</fieldset><SetupChecklist config={config} /></div>
        <footer className="save-bar"><div className="save-status">{config.dirty ? <span className="status-dot status-dot--warning" /> : <CheckCheck size={15} />}<div><strong>{config.dirty ? 'You have unsaved changes' : saved ? 'Saved to your environment file' : config.snapshot.exists ? 'Configuration loaded' : 'Ready when you are'}</strong><span>{saved && !config.dirty ? 'Restart the bot to apply changes.' : 'Settings are applied when the bot starts.'}</span></div></div>
          <div className="save-actions"><Button variant="ghost" disabled={!config.dirty || Boolean(config.busy)} onClick={() => setDiscardOpen(true)} className="discard-button"><RotateCcw size={13} />Discard</Button><Button onClick={() => void validate()} disabled={Boolean(config.busy)} busy={config.busy === 'validate'}>Check configuration</Button><Button variant="primary" onClick={() => void save()} disabled={(!config.dirty && config.snapshot.exists) || Boolean(config.busy)} busy={config.busy === 'save'}><Save size={14} />Save changes</Button></div>
        </footer>
        </>}
        <div className="page-footer"><span>just-bash / issue agent</span><span>Made for the way you build.</span></div>
      </>}
    </main>
    <Dialog open={environmentOpen} onClose={() => setEnvironmentOpen(false)} title="Environment" description="A redacted view of your current settings.">
      <div className="dialog-body"><div className="environment-path"><FileCode2 size={15} /><code>{config.snapshot?.file || '.env'}</code><Badge>Local file</Badge></div><p>Save changes writes to this file. Existing process environment variables can override it when the bot starts.</p><pre className="env-preview"><code>{environment || 'Configuration is not loaded.'}</code></pre>
        <div className="dialog-actions"><span className="field-hint">Secrets are masked. This preview is not a deployable file.</span><CopyButton value={environment} label="Copy redacted" /></div></div>
    </Dialog>
    <Dialog open={discardOpen} onClose={() => setDiscardOpen(false)} title={conflict ? 'Reload configuration?' : 'Discard unsaved changes?'} description={conflict ? 'The environment file changed outside this window. Reload it to continue.' : 'Return to the last saved configuration. This will clear any new secrets you entered.'}>
      <div className="dialog-actions dialog-actions--padded"><Button onClick={() => setDiscardOpen(false)}>Keep editing</Button><Button variant="primary" onClick={async () => { if (conflict) { await config.load(); setConflict(false); } else config.reset(); setDiscardOpen(false); setMessage(null); }}>{conflict ? 'Reload from file' : 'Discard changes'}</Button></div>
    </Dialog>
  </Shell>;
}
