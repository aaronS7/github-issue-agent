import { ArrowDown, ArrowUpRight, Check, ChevronRight, CircleDot, Layers, Terminal } from 'lucide-react';
import { setupItems } from '../lib/configuration';
import type { Configuration } from '../lib/use-configuration';

export function SetupChecklist({ config }: { config: Configuration }) {
  const items = setupItems(config.values, config.snapshot!, config.secrets);
  const requiredItems = items.filter(item => !item.optional);
  const count = requiredItems.filter(item => item.complete).length;
  return <aside className="context-rail" aria-label="Setup progress">
    <section className="checklist"><div className="rail-heading"><h2>Setup checklist</h2><span>{count} / {requiredItems.length}</span></div>
      <div className="progress-track" aria-label={`${count} of ${requiredItems.length} required settings entered`}>{requiredItems.map(item => <span key={item.label} className={item.complete ? 'complete' : ''} />)}</div>
      <p className="rail-description">A few settings, then you’re ready to run.</p>
      <div className="checklist-items">{items.map((item, index) => <a href={`#${item.tab}`} className={`checklist-item ${item.complete ? 'is-complete' : ''}`} key={item.label}>
        <span className="step-number">{item.complete ? <Check size={12} /> : index + 1}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span><ChevronRight size={13} />
      </a>)}</div>
      <a href="#setup" className="rail-link">Walk through setup<ArrowUpRight size={13} /></a>
      <p className="rail-footnote">Tracks entered settings. Use connection checks to verify access.</p>
    </section>
    <section className="flow-card"><div className="flow-illustration" aria-hidden="true"><span className="flow-node"><CircleDot size={19} /></span><span className="flow-line" /><span className="flow-node"><Layers size={19} /></span><span className="flow-line" /><span className="flow-node flow-node--bright"><Terminal size={19} /></span></div>
      <h3>From issue to implementation.</h3><p>GitHub issues enter a durable queue. Your agent works in its own checkout and saves changes for review.</p>
      <div className="flow-caption"><span>ISSUE</span><ArrowDown size={10} /><span>QUEUE</span><ArrowDown size={10} /><span>AGENT</span></div>
    </section>
    <div className="rail-help"><span className="status-dot" /><p>Changes take effect when you restart the bot.</p></div>
  </aside>;
}
