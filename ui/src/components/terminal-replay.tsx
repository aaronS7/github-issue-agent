import { useEffect, useRef, useState } from 'react';
import { Download, Film, RefreshCw } from 'lucide-react';
import type { Player } from 'asciinema-player';
import { Button, Notice } from './primitives';

export function TerminalReplay({ jobId, runId, active }: { jobId: number; runId: string; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState(0);
  const [speed, setSpeed] = useState(1);
  const position = useRef(0);
  const playing = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [partial, setPartial] = useState(false);
  const endpoint = `/api/runs/${jobId}/attempts/${encodeURIComponent(runId)}/recording`;
  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    let player: Player | undefined;
    setError(''); setLoading(true);
    const mount = async () => {
      try {
        const [module, response] = await Promise.all([
          import('asciinema-player'), fetch(endpoint, { signal: abort.signal, credentials: 'same-origin', cache: 'no-store' }),
        ]);
        if (!response.ok) throw new Error('This recording could not be loaded. Refresh to try again.');
        const data = await response.text();
        if (disposed || !container.current) return;
        setPartial(response.headers.get('X-Recording-Partial') === 'true');
        player = module.create({ data }, container.current, {
          autoPlay: playing.current, startAt: position.current, preload: true, fit: 'width', theme: 'asciinema', terminalFontFamily: 'Geist Mono, monospace',
          idleTimeLimit: 2, speed, controls: true,
        });
        player.addEventListener('play', () => { if (!disposed) playing.current = true; });
        player.addEventListener('pause', () => { if (!disposed) playing.current = false; });
        player.addEventListener('ended', () => { if (!disposed) playing.current = false; });
        player.addEventListener('error', () => { if (!disposed) setError('The terminal player could not read this recording. You can download the .cast file to inspect it.'); });
        setLoading(false);
      } catch (e) {
        if (!disposed) { setError(e instanceof Error ? e.message : 'Unable to load the recording.'); setLoading(false); }
      }
    };
    void mount();
    return () => {
      disposed = true; abort.abort();
      if (player) { position.current = player.getCurrentTime(); player.dispose(); }
    };
  }, [endpoint, version, speed, active]);
  return <section className="replay-section" aria-label="Terminal replay">
    <div className="replay-heading"><div><Film size={15} /><h3>Terminal replay</h3></div><div className="inline-actions">
      <label className="replay-speed">Speed<select className="input" aria-label="Playback speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      {(active || error) && <Button variant="ghost" onClick={() => setVersion(value => value + 1)}><RefreshCw size={13} />Refresh recording</Button>}
      <a className="button button--ghost" href={endpoint} download={`run-${jobId}-${runId}.cast`}><Download size={13} />Download .cast</a>
    </div></div>
    {error && <Notice tone="error" role="alert">{error}</Notice>}
    {loading && <p className="field-hint">Loading terminal player…</p>}
    <div ref={container} className="terminal-player" />
    <p className="replay-caption">{partial && !active && 'This is a partial recording. '}{active ? 'Snapshot of the recording so far. Refresh to include new commands.' : 'Commands and completed output, replayed with their recorded timing.'} Idle pauses are capped at two seconds.</p>
  </section>;
}
