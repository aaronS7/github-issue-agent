import { ArrowRight, Check } from 'lucide-react';
import { GitHubIcon as Github } from '../components/icons';
import { Badge, Button, CodeBlock, ExternalLinkButton, Section } from '../components/primitives';
import type { Configuration } from '../lib/use-configuration';

export function SetupPage({ config }: { config: Configuration }) {
  const github = config.values.GITHUB_SERVER_URL || 'https://github.com';
  let newApp = 'https://github.com/settings/apps/new';
  try { const url = new URL(github); if (url.protocol === 'https:' && !url.username && !url.password) newApp = `${url.origin}/settings/apps/new`; } catch { /* Keep GitHub's standard URL. */ }
  return <div className="guide-content">
    <div className="guide-callout"><Github size={24} /><div><strong>A GitHub App, built for your workflow.</strong><p>Register once. The service handles installation tokens and renewal.</p></div><Badge>~5 minutes</Badge></div>
    <Section title="01 / Create your GitHub App" description="Use an account or organization that owns the repository.">
      <p>In GitHub, go to Settings → Developer settings → GitHub Apps → New GitHub App. Choose a name and a homepage URL you control. OAuth and device flow are not needed.</p>
      <ExternalLinkButton href={newApp}>Create a GitHub App</ExternalLinkButton>
    </Section>
    <Section title="02 / Connect the webhook" description="GitHub needs a public HTTPS URL that reaches your bot.">
      <CodeBlock value="https://your-domain.com/webhooks/github" label="Webhook URL" />
      <p>Enable the webhook and SSL verification. Generate a secret in the GitHub tab, then copy that same secret into GitHub. Your bot listens on port {config.values.PORT || '3000'} by default; route the public webhook URL to that listener.</p>
      <p>The configuration console is local. The public URL should reach the bot’s webhook service.</p>
      <a href="#github" className="text-link">Configure the webhook<ArrowRight size={13} /></a>
    </Section>
    <Section title="03 / Set permissions & events" description="Grant only the access the current bot uses.">
      <div className="permissions-table"><div><strong>Repository permission</strong><strong>Access</strong></div><div><span>Contents</span><span>Read-only</span></div><div><span>Issues</span><span>Read & write</span></div><div><span>Metadata</span><span>Read-only</span></div></div>
      <p>Subscribe to <strong>Issues</strong> and <strong>Issue comments</strong>. Issues write access is used for replies and reactions when feedback is enabled.</p>
    </Section>
    <Section title="04 / Install & authenticate" description="Install the App on your chosen repository.">
      <p>Copy the App’s Client ID. Generate a private key, store the PEM file on the machine running your bot, and enter its path in Authentication. You can leave Installation ID empty; the service discovers it from your repository.</p>
      <p>Use <strong>Test connection</strong> to check authentication and repository access. It does not verify webhook delivery or post a comment.</p>
      <a href="#github" className="text-link">Add App credentials<ArrowRight size={13} /></a>
    </Section>
    <Section title="05 / Configure, save & run" description="Choose a model, save your configuration, and start the bot.">
      <p>Set a model ID and credentials under Model & runtime. Use Check configuration to find missing settings, then Save changes. Restart a running bot to load the saved file.</p>
      <CodeBlock value="npm run build && npm start" label="From the project directory · uses .env" />
      <p>If you edited a different environment file, start with that file:</p><CodeBlock value="node --env-file=/path/to/agent.env dist/cli.js serve" />
      <p>Open an issue in the installed repository. The bot queues a run, edits an isolated checkout, and saves a local commit and patch. It does not push changes or open a pull request.</p>
      <div className="guide-next"><Check size={16} /><span>Follow up with a comment starting with <code>{config.values.COMMENT_PREFIX || '(any non-bot comment)'}</code>.</span></div>
    </Section>
    <Section title="Make room for your own tools" description="Extend the agent without changing its single-tool interface.">
      <p>Set an extension module under Tools to register capabilities and lifecycle hooks. Each capability is a just-bash command. A custom model adapter can add company instructions and steer prompts. See <code>examples/extensions.mjs</code> and <code>docs/extensions.md</code> in this project for the working interface.</p>
      <Button onClick={() => { window.location.hash = 'tools'; }}>Configure extensions<ArrowRight size={13} /></Button>
    </Section>
  </div>;
}
