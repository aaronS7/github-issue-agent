import { ArrowUpRight, Blocks, Globe, LockKeyhole, MessageSquare, Terminal, ThumbsUp } from 'lucide-react';
import { Badge, Section } from '../components/primitives';
import { SettingField } from '../components/fields';
import type { Configuration } from '../lib/use-configuration';

export function ToolsPage({ config }: { config: Configuration }) {
  const feedback = config.values.GITHUB_FEEDBACK !== 'false';
  return <>
    <div className="tools-intro"><span className="terminal-hero"><Terminal size={25} /></span><div><h2>One shell. Composable tools.</h2><p>Your model calls bash. Capabilities become commands it can combine with pipes, files, and familiar shell syntax.</p></div></div>
    <Section title="Built-in capabilities" description="Available in each isolated issue workspace.">
      <div className="capability-list">{[
        { name: 'just-bash', detail: 'Read, search, and edit files in the checkout.', icon: Terminal, on: true },
        { name: 'agent-tools', detail: 'Discover available capability commands.', icon: Blocks, on: true },
        { name: 'github-comment', detail: 'Queue a reply to the current GitHub issue.', icon: MessageSquare, on: feedback },
        { name: 'github-react', detail: 'Queue a reaction on the issue or comment.', icon: ThumbsUp, on: feedback },
      ].map(item => <div className="capability" key={item.name}><span className="capability-icon"><item.icon size={16} /></span><div><code>{item.name}</code><p>{item.detail}</p></div><Badge dot tone={item.on ? 'success' : 'neutral'}>{item.on ? 'Enabled' : 'Feedback off'}</Badge></div>)}</div>
      <p className="field-hint">GitHub commands follow the Comments & reactions setting in <a href="#triggers">Triggers</a>.</p>
    </Section>
    <Section title="Your extensions" description="Add commands, lifecycle hooks, or your own model adapter." action={<Blocks size={18} className="muted" />}>
      <SettingField config={config} name="EXTENSIONS" placeholder="./examples/extensions.mjs" hint="A trusted JavaScript module on the bot’s machine. Loaded when the service starts." optional />
      <pre className="extension-example"><code><span className="code-muted">// extensions.mjs</span>{'\n'}<span className="code-keyword">export default</span>{' {\n  capabilities: [projectInfo],\n  hooks: [onComplete],\n  // createModel: (job, issue) => adapter,\n};'}</code></pre>
      <a href="#setup" className="text-link">Learn how extensions fit in<ArrowUpRight size={13} /></a>
    </Section>
    <Section title="Execution boundaries" description="The current shell policy is fixed in the runtime.">
      <div className="policy-row"><Globe size={16} /><div><strong>Shell internet access</strong><p>Network commands are not exposed to just-bash.</p></div><Badge>Blocked</Badge></div>
      <div className="policy-row"><LockKeyhole size={16} /><div><strong>Host commands</strong><p>No host shell, package manager, Python, or JavaScript execution.</p></div><Badge>Blocked</Badge></div>
      <p className="field-hint">Extensions run as trusted host code and can use network and filesystem APIs. These shell boundaries do not restrict extension code.</p>
    </Section>
  </>;
}
