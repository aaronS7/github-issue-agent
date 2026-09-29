import { Activity, ArrowUpRight, BookOpen, ChevronRight, Code2, FileCode2, Settings2, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Page } from '../lib/configuration';
import { Badge } from './primitives';

export function Shell({ page, repository, onEnvironment, children }:
  { page: Page; repository?: string; onEnvironment: () => void; children: ReactNode }) {
  return <div className="app-shell"><a className="skip-link" href="#main">Skip to configuration</a>
    <aside className="sidebar">
      <a className="brand" href="#github" aria-label="just-bash home"><span className="brand-mark"><Terminal size={18} strokeWidth={2.3} /></span><span>just-bash<span className="brand-period">.</span></span></a>
      <div className="workspace-switch"><span className="workspace-avatar"><Code2 size={15} /></span><div><strong>Issue agent</strong><span>Local workspace</span></div><Badge>v0.1</Badge></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <a className={`nav-item ${page !== 'setup' && page !== 'runs' ? 'nav-item--active' : ''}`} href="#github" aria-current={page !== 'setup' && page !== 'runs' ? 'page' : undefined}><Settings2 size={16} />Configuration</a>
        <a className={`nav-item ${page === 'runs' ? 'nav-item--active' : ''}`} href="#runs" aria-current={page === 'runs' ? 'page' : undefined}><Activity size={16} />Runs</a>
        <button type="button" className="nav-item" onClick={onEnvironment}><FileCode2 size={16} />Environment<span className="nav-suffix">.env</span></button>
        <a className={`nav-item ${page === 'setup' ? 'nav-item--active' : ''}`} href="#setup" aria-current={page === 'setup' ? 'page' : undefined}><BookOpen size={16} />Setup guide</a>
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><Terminal size={15} /><p>One shell.<br /><span>Your tools. Your agent.</span></p></div>
        <a href="https://github.com/vercel-labs/just-bash" target="_blank" rel="noreferrer" className="sidebar-link">Built with just-bash<ArrowUpRight size={14} /></a>
      </div>
    </aside>
    <div className="app-main"><header className="topbar"><div className="breadcrumbs"><span className="breadcrumb-avatar">J</span><span>Workspace</span><ChevronRight size={12} /><span className="breadcrumb-current">{repository || 'Issue agent'}</span></div><span className="local-indicator"><span className="status-dot" />Local configuration</span></header>{children}</div>
  </div>;
}
