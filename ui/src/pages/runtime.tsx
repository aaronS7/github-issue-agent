import { Cpu, Database, Gauge } from 'lucide-react';
import type { Configuration } from '../lib/use-configuration';
import { Field, SecretField, SettingField } from '../components/fields';
import { Badge, Section } from '../components/primitives';

export function RuntimePage({ config }: { config: Configuration }) {
  return <>
    <Section title="Model" description="Connect the model that will power your agent." action={<Cpu size={18} className="muted" />}>
      <div className="stack"><div className="field-grid"><Field id="MODEL_PROVIDER" label="Provider" error={config.errors.MODEL_PROVIDER}>
        <select id="MODEL_PROVIDER" className="input" value={config.values.MODEL_PROVIDER || 'anthropic'} onChange={event => config.setValue('MODEL_PROVIDER', event.target.value)}>
          <option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI-compatible API</option>
        </select></Field><SettingField config={config} name="MODEL" placeholder="Your provider’s model ID" hint="Use a model with tool-calling support." /></div>
        <SecretField config={config} name="MODEL_API_KEY" hint="Stored in your local environment file and never returned by the configuration API." />
        {config.snapshot?.secrets.ANTHROPIC_API_KEY && <p className="field-hint">An ANTHROPIC_API_KEY is also set in this file. The Anthropic adapter uses it when MODEL_API_KEY is absent. Manage that fallback in the environment file.</p>}
        <SettingField config={config} name="MODEL_BASE_URL" type="url" placeholder={config.values.MODEL_PROVIDER === 'openai-compatible' ? 'https://your-provider.com/v1' : 'Provider default'}
          hint={config.values.MODEL_PROVIDER === 'openai-compatible' ? 'Required. Enter the full API base URL, including /v1 if needed.' : 'Override the Anthropic endpoint only if your setup requires it.'} optional={config.values.MODEL_PROVIDER !== 'openai-compatible'} />
        {config.values.EXTENSIONS && <p className="field-hint">If your extension exports createModel, it takes precedence over these model settings.</p>}
      </div>
    </Section>
    <Section title="Run limits" description="Set the pace and boundaries for each run." action={<Gauge size={18} className="muted" />}>
      <div className="field-grid"><SettingField config={config} name="CONCURRENCY" type="number" min={1} max={64} hint="Active agents per service process." />
        <SettingField config={config} name="MAX_STEPS" type="number" min={1} max={1000} hint="Maximum bash calls in one run." />
        <SettingField config={config} name="RUN_TIMEOUT_MS" type="number" min={1000} step={1000} label="Run timeout (ms)" hint={`${Number(config.values.RUN_TIMEOUT_MS || 0) / 60000} minutes per attempt.`} />
        <SettingField config={config} name="MAX_ATTEMPTS" type="number" min={1} max={100} hint="Attempts for jobs and GitHub feedback." /></div>
    </Section>
    <Section title="Storage & service" description="Keep queued work and run artifacts on a persistent local disk." action={<Badge><Database size={11} />SQLite</Badge>}>
      <SettingField config={config} name="DATA_DIR" placeholder="./data" hint="Contains the queue, repository cache, and saved run artifacts. Changing this selects a different data directory." />
      <details className="disclosure"><summary>Advanced service settings</summary><div className="stack"><div className="field-grid">
        <SettingField config={config} name="HOST" placeholder="127.0.0.1" hint="Bot webhook listener. This does not change the UI address." />
        <SettingField config={config} name="PORT" type="number" min={0} max={65535} hint="Bot webhook port. Default: 3000." /></div>
        <SettingField config={config} name="LEASE_MS" type="number" min={3000} step={1000} label="Lease duration (ms)" hint="Workers renew ownership every third of this interval. Default: 60000." />
      </div></details>
    </Section>
  </>;
}
