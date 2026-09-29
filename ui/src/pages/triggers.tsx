import { ArrowRight, Check, MessageSquare, SlidersHorizontal, Zap } from 'lucide-react';
import type { Configuration } from '../lib/use-configuration';
import { Badge, Section } from '../components/primitives';
import { SettingField, Toggle } from '../components/fields';

const events = [
  { id: 'opened', name: 'Issue opened', detail: 'Start when a new issue is created.' },
  { id: 'reopened', name: 'Issue reopened', detail: 'Pick up an issue when it is reopened.' },
  { id: 'labeled', name: 'Label added', detail: 'Re-evaluate an issue when it gets a label.' },
];
export function TriggersPage({ config }: { config: Configuration }) {
  const selected = (config.values.ISSUE_ACTIONS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const hasFilters = Boolean(config.values.ISSUE_LABELS || config.values.ISSUE_AUTHORS);
  return <>
    <div className="trigger-summary"><span className="summary-icon"><Zap size={18} /></span><div><strong>{hasFilters ? 'A little more selective.' : 'Every issue is a starting point.'}</strong><p>{hasFilters ? 'Only issues matching your filters will enter the queue.' : 'All issues matching the selected events can trigger a run.'}</p></div><Badge>{hasFilters ? 'Filtered' : 'All issues'}</Badge></div>
    <Section title="Issue events" description="Choose when your agent starts working." action={<Zap size={17} className="muted" />}>
      <div className="event-list">{events.map(event => <label className="event-option" key={event.id}>
        <input type="checkbox" checked={selected.includes(event.id)} onChange={e => config.setValue('ISSUE_ACTIONS',
          (e.target.checked ? [...selected, event.id] : selected.filter(value => value !== event.id)).join(','))} />
        <span className="checkbox-mark">{selected.includes(event.id) && <Check size={12} />}</span><span><strong>{event.name}</strong><small>{event.detail}</small></span>
      </label>)}</div>
      {!selected.length && <p className="field-hint">Issue events are disabled. Matching comments can still trigger runs.</p>}
      <details className="disclosure"><summary>Additional GitHub issue actions</summary><SettingField config={config} name="ISSUE_ACTIONS" hint="Comma-separated webhook action names. An empty value disables issue events." /></details>
    </Section>
    <Section title="Issue filters" description="Leave these empty to accept issues from anyone." action={<SlidersHorizontal size={17} className="muted" />}>
      <div className="stack"><SettingField config={config} name="ISSUE_LABELS" placeholder="agent, ready" hint="Comma-separated labels. Every listed label must be on the issue." optional />
        <SettingField config={config} name="ISSUE_AUTHORS" placeholder="octocat, teammate" hint="GitHub logins of allowed issue authors. This also applies to comment-triggered runs." optional /></div>
    </Section>
    <Section title="Conversation & feedback" description="Keep work moving in the issue thread." action={<MessageSquare size={17} className="muted" />}>
      <SettingField config={config} name="COMMENT_PREFIX" placeholder="/agent" hint="New comments starting with this command trigger follow-up runs. Empty accepts every non-bot comment." />
      <div className="comment-example"><span className="comment-avatar">Y</span><span><code>{config.values.COMMENT_PREFIX || ''}</code> also handle the empty state</span><ArrowRight size={14} /><Badge>New run</Badge></div>
      <Toggle id="GITHUB_FEEDBACK" checked={config.values.GITHUB_FEEDBACK !== 'false'} onChange={value => config.setValue('GITHUB_FEEDBACK', String(value))}
        label="Comments & reactions" description="Post lifecycle updates and let the agent reply on GitHub." />
      <SettingField config={config} name="BOT_LOGINS" placeholder="your-company-bot" hint="Additional service-account logins to ignore. GitHub bot comments and the agent’s own replies are already ignored." optional />
    </Section>
  </>;
}
