import type { Configuration } from '../lib/use-configuration';
import { SecretField, SettingField } from './fields';

export function CloudflareRelaySettings({ config }: { config: Configuration }) {
  return <details className="disclosure"><summary>Cloudflare relay · optional</summary>
    <div className="stack">
      <p className="field-hint">Receive webhooks while this machine is offline. Deploy the Worker template in deploy/cloudflare, then add its connection settings here. The service pulls events over HTTPS; restart it after saving.</p>
      <SettingField config={config} name="CLOUDFLARE_RELAY_URL" type="url"
        placeholder="https://github-issue-webhook-relay.your-subdomain.workers.dev"
        hint="Worker origin, without /webhooks/github. All five connection settings are required to enable the relay." />
      <div className="field-grid">
        <SettingField config={config} name="CLOUDFLARE_ACCOUNT_ID" placeholder="32-character account ID" />
        <SettingField config={config} name="CLOUDFLARE_QUEUE_ID" placeholder="32-character queue ID" />
      </div>
      <SecretField config={config} name="CLOUDFLARE_API_TOKEN" hint="Cloudflare API token with Queues Read and Write for the account. It stays on this machine." />
      <SecretField config={config} name="CLOUDFLARE_RELAY_TOKEN" hint="Use the same value as the Worker’s RELAY_AUTH_TOKEN secret. This allows the service to retrieve private webhook payloads." />
      <SettingField config={config} name="CLOUDFLARE_POLL_INTERVAL_MS" inputMode="numeric"
        hint="Delay between polls in milliseconds. Empty polls also use Cloudflare API operations." />
      <p className="field-hint">Use the same webhook secret in GitHub, the Worker, and this service. Configuration checks validate these fields locally; Test connection checks GitHub access.</p>
    </div>
  </details>;
}
