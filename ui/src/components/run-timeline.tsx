import { Check, ChevronRight, CircleAlert, Clock3, Cpu, Layers, Terminal } from 'lucide-react';
import type { RunEvent } from '../lib/runs';
import { duration } from '../lib/runs';
import { Badge } from './primitives';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' ? value : 0;
function label(event: RunEvent) {
  const data = event.data;
  switch (event.type) {
    case 'model-start': return `Model call ${data.call ?? data.turn ?? ''}`.trim();
    case 'model-end': return data.outcome === 'error' ? 'Model call failed' : 'Model response received';
    case 'model-error': return 'Model call failed';
    case 'command-start': return `Command ${data.step ?? ''} started`.trim();
    case 'command': return `Command ${data.step ?? ''} finished`.trim();
    case 'command-error': return 'Command interrupted';
    case 'capability-start': return `${data.name ?? data.capability ?? 'Capability'} started`;
    case 'capability-end': return `${data.name ?? data.capability ?? 'Capability'} finished`;
    case 'final': return 'Agent summary';
    case 'phase': return text(data.phase).replaceAll('-', ' ') || 'Phase changed';
    case 'started': case 'run-start': return 'Attempt started';
    case 'finished': case 'run-end': return 'Attempt finished';
    default: return event.type.replaceAll('-', ' ');
  }
}
export function RunTimeline({ events }: { events: RunEvent[] }) {
  if (!events.length) return <div className="timeline-empty"><Clock3 size={18} /><p>No events recorded yet. New events appear as the worker progresses.</p></div>;
  return <ol className="run-timeline" aria-label="Run event timeline">{events.map(event => {
    const data = event.data;
    const failed = number(data.exitCode) !== 0 || Boolean(data.error) || event.type.endsWith('error');
    const Icon = failed ? CircleAlert : event.type.startsWith('model') ? Cpu : event.type.startsWith('command') ? Terminal : event.type.startsWith('capability') ? Layers : Check;
    const script = text(data.script), stdout = text(data.stdout), stderr = text(data.stderr);
    const error = text(data.error), summary = text(data.summary), message = text(data.message);
    const details = Boolean(script || stdout || stderr || error || summary || message || data.truncated);
    return <li className={`timeline-event ${failed ? 'timeline-event--failed' : ''}`} key={event.id}>
      <span className="timeline-icon"><Icon size={12} /></span><div className="timeline-event-body"><details open={failed || event.type === 'final'}>
        <summary className={!details ? 'timeline-summary--empty' : ''}><span className="event-label">{label(event)}</span>
          {typeof data.exitCode === 'number' && <Badge tone={failed ? 'warning' : 'neutral'}>exit {data.exitCode}</Badge>}
          {typeof data.durationMs === 'number' && <span className="event-duration">{duration(data.durationMs)}</span>}
          <time className="event-time" title={new Date(event.at).toLocaleString()}>+{duration(event.elapsedMs)}</time>{details && <ChevronRight size={12} />}
        </summary>
        {details && <div className="event-content">
          {Boolean(data.truncated) && <p className="timeline-notice">This event exceeded the capture limit; some content was shortened.</p>}
          {script && <pre className="event-script"><code>$ {script}</code></pre>}
          {stdout && <div className="event-output"><span>stdout</span><pre>{stdout}</pre></div>}
          {stderr && <div className="event-output event-output--error"><span>stderr</span><pre>{stderr}</pre></div>}
          {error && <pre className="event-error">{error}</pre>}
          {summary && <p className="event-summary-text">{summary}</p>}
          {message && <p className="event-summary-text">{message}</p>}
        </div>}
      </details></div>
    </li>;
  })}</ol>;
}
