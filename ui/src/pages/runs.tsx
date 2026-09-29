import { useEffect, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, CheckCheck, ChevronRight, CircleAlert, Clock3, Download, Film, FolderGit2, GitCommitHorizontal, Layers, RefreshCw, Settings2, Terminal } from 'lucide-react';
import { Badge, Button, Notice } from '../components/primitives';
import { TerminalReplay } from '../components/terminal-replay';
import { RunTimeline } from '../components/run-timeline';
import { dateTime, duration, runLink, selectedRun, statusLabel } from '../lib/runs';
import type { JobStatus, RunAttempt, RunJob } from '../lib/runs';
import { useRunDetail, useRunList } from '../lib/use-runs';

function StatusBadge({ status }: { status: string }) {
  return <Badge dot tone={['done', 'succeeded'].includes(status) ? 'success' : ['dead', 'failed', 'interrupted', 'lease-expired', 'retrying'].includes(status) ? 'warning' : 'neutral'}>{statusLabel(status)}</Badge>;
}
function Phase({ run, job }: { run: RunAttempt | null; job: RunJob }) {
  if (run?.status === 'lease-expired' || (job.status === 'running' && (job.leaseExpiresAt ?? 0) < Date.now())) return <span className="run-phase run-phase--warning">Lease expired · waiting for recovery</span>;
  if (job.status === 'queued' && job.attempts > 0) return <span className="run-phase">Retry scheduled · {dateTime(job.nextRunAt)}</span>;
  return <span className="run-phase">{run?.phase?.replaceAll('-', ' ') || (job.status === 'queued' ? 'Waiting for a worker' : 'No trace available')}</span>;
}
function RefreshStatus({ updatedAt, loading, error, onRefresh }: { updatedAt: number | null; loading: boolean; error: string; onRefresh: () => void }) {
  return <div className="run-refresh"><span className={`refresh-label ${error ? 'refresh-label--error' : ''}`} title={updatedAt ? `Last read ${dateTime(updatedAt)}` : 'Waiting for data'}><span className="status-dot" />{error ? 'Refresh failed' : loading ? 'Refreshing' : 'Updates every 2s'}</span><Button variant="ghost" onClick={onRefresh} aria-label="Refresh runs"><RefreshCw size={14} className={loading ? 'spin' : ''} /></Button></div>;
}

function RunListView() {
  const [status, setStatus] = useState<JobStatus | 'all'>('all');
  const [cursors, setCursors] = useState<number[]>([]);
  const { data, error, loading, updatedAt, refresh } = useRunList(status, cursors.at(-1));
  const cards = [
    { status: 'running' as const, label: 'Running', icon: Activity },
    { status: 'queued' as const, label: 'Queued', icon: Layers },
    { status: 'done' as const, label: 'Completed', icon: CheckCheck },
    { status: 'dead' as const, label: 'Failed', icon: CircleAlert },
  ];
  const filter = (value: JobStatus | 'all') => { setStatus(value); setCursors([]); };
  return <div className="runs-content">
    <div className="run-stat-grid">{cards.map(card => <button type="button" className={`run-stat ${status === card.status ? 'run-stat--selected' : ''}`} key={card.status} onClick={() => filter(status === card.status ? 'all' : card.status)} aria-pressed={status === card.status}>
      <span><card.icon size={14} />{card.label}</span><strong>{data ? data.counts.jobs[card.status] : '—'}</strong>
    </button>)}</div>
    <div className="runs-toolbar"><div className="inline-actions"><h2>Issue jobs</h2><select className="input run-filter" aria-label="Filter runs" value={status} onChange={e => filter(e.target.value as JobStatus | 'all')}><option value="all">All statuses</option>{cards.map(card => <option value={card.status} key={card.status}>{card.label}</option>)}</select></div><RefreshStatus updatedAt={updatedAt} loading={loading} error={error} onRefresh={refresh} /></div>
    {error && <Notice tone="error" role="alert">{error} {data && 'Showing the last successful read.'}</Notice>}
    {!data && loading ? <div className="run-empty"><RefreshCw className="spin" size={22} /><p>Reading your run history…</p></div> : data && <>
      {!data.jobs.length ? <div className="run-empty"><span className="empty-terminal"><Terminal size={26} /></span><h2>{status !== 'all' ? `No ${statusLabel(status).toLowerCase()} jobs` : 'Your next issue starts here.'}</h2><p>{data.available ? 'Matching jobs will appear here as GitHub issues enter the queue.' : 'Start the bot and send a GitHub issue to create your first run. This view reads the saved data directory.'}</p><a className="text-link" href="#setup">View setup guide<ArrowRight size={13} /></a></div> :
        <section className="run-table" aria-label="Issue jobs"><div className="run-table-head" aria-hidden="true"><span>Issue / repository</span><span>Status</span><span>Attempt</span><span>Created</span></div>
          {data.jobs.map(job => <a href={runLink(job.id)} className="run-table-row" key={job.id} aria-label={`Inspect job ${job.id}: ${job.title || `Issue ${job.issueNumber}`}`}>
            <div className="run-title"><span className="issue-symbol"><FolderGit2 size={17} /></span><div><strong>{job.title || `Issue #${job.issueNumber}`}</strong><small>{job.repository} <span>#{job.issueNumber}</span> · Job {job.id}</small></div></div>
            <div><StatusBadge status={job.status} /><Phase run={job.latestRun} job={job} /></div><div className="run-attempt-cell"><span>{job.attempts || '—'}</span>{job.latestRun?.hasRecording && <Film size={13} aria-label="Recording available" />}</div><div className="run-date"><time>{dateTime(job.createdAt)}</time><ChevronRight size={13} /></div>
          </a>)}
        </section>}
      <div className="runs-pagination"><span>{data.jobs.length} jobs shown</span><div className="inline-actions"><Button disabled={!cursors.length || loading} onClick={() => setCursors(previous => previous.slice(0, -1))}>Newer</Button><Button disabled={data.nextCursor === null || loading} onClick={() => { if (data.nextCursor !== null) setCursors(previous => [...previous, data.nextCursor!]); }}>Older<ArrowRight size={12} /></Button></div></div>
      <section className="feedback-overview"><div><span className="feedback-icon"><CheckCheck size={15} /></span><div><h3>GitHub feedback</h3><p>Delivery is tracked separately from code changes.</p></div></div><div className="feedback-counts"><span><strong>{data.counts.outbox.queued + data.counts.outbox.running}</strong> pending</span><span><strong>{data.counts.outbox.done}</strong> delivered</span><span className={data.counts.outbox.dead ? 'warning-text' : ''}><strong>{data.counts.outbox.dead}</strong> failed</span></div></section>
      <p className="run-source"><FolderGit2 size={12} /><span>Reading <code>{data.dataDir}</code> from the saved configuration. Queue status does not confirm an idle worker is online.</span></p>
    </>}
  </div>;
}

function RunDetailView({ jobId, runId }: { jobId: number; runId?: string }) {
  const { data, error, loading, updatedAt, omittedEvents, refresh } = useRunDetail(jobId, runId);
  const [view, setView] = useState<'timeline' | 'replay'>('timeline');
  const [follow, setFollow] = useState(false);
  useEffect(() => { if (follow) document.getElementById('timeline-end')?.scrollIntoView({ block: 'end', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [data?.events.at(-1)?.id, follow]);
  return <div className="run-detail">
    <div className="run-detail-toolbar"><a href="#runs" className="text-link"><ArrowLeft size={14} />All runs</a><RefreshStatus updatedAt={updatedAt} loading={loading} error={error} onRefresh={refresh} /></div>
    {error && <Notice tone="error" role="alert">{error} {data && 'Showing the last successful read.'}</Notice>}
    {!data ? <div className="run-empty"><Clock3 size={20} /><p>{loading ? 'Reading this run…' : 'No run details available.'}</p></div> : <>
      <header className="run-detail-header"><div><div className="run-issue-meta">{data.job.repository} <span>#{data.job.issueNumber}</span><span>Job {jobId}</span></div><h2>{data.job.title || `Issue #${data.job.issueNumber}`}</h2><div className="inline-actions"><StatusBadge status={data.job.status} /><Phase run={data.job.latestRun} job={data.job} /></div></div>
        {data.attempts.length > 0 && <div className="attempt-picker"><label htmlFor="run-attempt">Viewing attempt</label><select className="input" id="run-attempt" value={runId || ''} onChange={event => { window.location.hash = runLink(jobId, event.target.value || undefined); }}><option value="">Latest attempt</option>{data.attempts.map(attempt => <option key={attempt.id} value={attempt.id}>Attempt {attempt.attempt} · {statusLabel(attempt.status)} · {dateTime(attempt.startedAt)}</option>)}</select></div>}
      </header>
      {data.run ? <>
        <div className="attempt-summary"><StatusBadge status={data.run.status} /><span>Attempt {data.run.attempt}</span><span>Started {dateTime(data.run.startedAt)}</span><code>{data.run.id.slice(0, 8)}</code></div>
        <div className="run-metrics"><div><span>{data.run.finishedAt || data.run.status === 'running' ? 'Elapsed' : 'Last observed at'}</span><strong>{duration((data.run.finishedAt ?? (data.run.status === 'running' ? Date.now() : data.run.updatedAt)) - data.run.startedAt)}</strong></div><div><span>Bash calls</span><strong>{data.run.steps}<small>{data.run.failedCommands ? `${data.run.failedCommands} failed or interrupted` : 'recorded'}</small></strong></div><div><span>Model calls</span><strong>{data.run.modelCalls}<small>{duration(data.run.modelMs)}</small></strong></div><div><span>Tokens in / out</span><strong className="token-metric">{data.run.inputTokens?.toLocaleString() ?? '—'} / {data.run.outputTokens?.toLocaleString() ?? '—'}</strong><small>Reported usage only</small></div></div>
        {data.run.error && <Notice tone="error"><CircleAlert size={16} /><span>{data.run.error}</span></Notice>}
        {(data.run.recordingTruncated || data.run.traceTruncated) && <Notice>Capture is incomplete. {data.run.recordingTruncated && 'The recording is partial. '}{data.run.traceTruncated && 'Some trace events were omitted. '}Job execution continued.</Notice>}
        <div className="run-view-toolbar"><nav className="run-view-tabs" aria-label="Run view"><button type="button" className={view === 'timeline' ? 'selected' : ''} onClick={() => setView('timeline')}><Activity size={13} />Timeline</button><button type="button" className={view === 'replay' ? 'selected' : ''} onClick={() => setView('replay')}><Film size={13} />Replay{!data.run.hasRecording && <span>Off</span>}</button></nav>
          {view === 'timeline' && <label className="follow-toggle"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Follow events</label>}
        </div>
        {view === 'timeline' ? <section className="timeline-panel"><div className="timeline-panel-heading"><h3>Attempt timeline</h3><a className="text-link" href={`/api/runs/${jobId}/attempts/${data.run.id}/events.jsonl`} download><Download size={12} />Export events</a></div>
          {data.hasMore && <p className="timeline-notice">Catching up with recorded events…</p>}
          {omittedEvents > 0 && <p className="timeline-notice">Showing the latest 1,000 loaded events. Export the timeline for the full captured history.</p>}
          <RunTimeline events={data.events} /><span id="timeline-end" />
        </section> : data.run.hasRecording ? <TerminalReplay key={data.run.id} jobId={jobId} runId={data.run.id} active={data.run.status === 'running' || data.run.status === 'lease-expired'} /> : <div className="run-empty replay-empty"><Film size={24} /><h3>No recording for this attempt</h3><p>Enable terminal recording in Observability, then restart the bot. The timeline remains available with recording off.</p><a href="#observability" className="text-link">Recording settings<ArrowRight size={13} /></a></div>}
      </> : <div className="run-empty"><Layers size={24} /><h3>{data.job.status === 'queued' ? 'Waiting for an agent' : 'No trace for this job'}</h3><p>{data.job.status === 'queued' ? 'A timeline appears when a worker claims this issue.' : 'This job may predate event capture, or its observability data is unavailable.'}</p>{data.job.lastError && <Notice tone="error">{data.job.lastError}</Notice>}</div>}
      {data.job.result && <section className="run-result"><div className="inline-actions"><GitCommitHorizontal size={16} /><h3>Saved result</h3><Badge>{data.job.result.changed ? 'Changes saved' : 'No file changes'}</Badge></div>{data.job.result.commit && <code>{data.job.result.commit}</code>}<p>{data.job.result.summary}</p></section>}
      <section className="run-feedback"><div className="timeline-panel-heading"><h3>GitHub feedback for this job</h3><span>{data.feedback.length} deliveries</span></div>{data.feedback.length ? data.feedback.map(effect => <div className="feedback-entry" key={effect.id}><span>{effect.kind} <small>#{effect.id}</small></span><span>{effect.attempts} attempts</span>{effect.status === 'done' ? <Badge tone="success" dot>Delivered</Badge> : <StatusBadge status={effect.status} />}{effect.lastError && <p>{effect.lastError}</p>}</div>) : <p className="field-hint">No feedback deliveries have been queued.</p>}</section>
    </>}
  </div>;
}

export function RunsPage({ dirty }: { dirty: boolean }) {
  const [selection, setSelection] = useState(selectedRun);
  useEffect(() => { const changed = () => setSelection(selectedRun()); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  return <><div className="runs-topline"><span><Activity size={14} />Local run observability</span><a href="#observability" className="text-link"><Settings2 size={13} />Recording settings</a></div>
    {dirty && <Notice>Configuration has unsaved changes. This view reads the saved data directory.</Notice>}
    {selection.jobId ? <RunDetailView key={`${selection.jobId}/${selection.runId || 'latest'}`} jobId={selection.jobId} runId={selection.runId} /> : <RunListView />}
  </>;
}
