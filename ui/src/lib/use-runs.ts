import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobStatus, RunDetail, RunList } from './runs';
import { fetchRuns } from './runs';

export function useRunList(status: JobStatus | 'all', before?: number) {
  const [data, setData] = useState<RunList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true; setLoading(true);
      try {
        const next = await fetchRuns<RunList>(`/api/runs?status=${status}${before ? `&before=${before}` : ''}`, controller.signal);
        if (!controller.signal.aborted) { setData(next); setError(''); setUpdatedAt(Date.now()); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to read runs.'); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [status, before, revision]);
  return { data, error, loading, updatedAt, refresh: () => setRevision(value => value + 1) };
}

export function useRunDetail(jobId: number, runId?: string) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [omittedEvents, setOmittedEvents] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let pending = false, cursor = 0, activeRun: string | null = null;
    let accumulated: RunDetail['events'] = [];
    let omitted = 0;
    setData(null); setError(''); setLoading(true); setOmittedEvents(0);
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        for (let batch = 0; batch < 5; batch++) {
          const base = `/api/runs/${jobId}${runId ? `/attempts/${encodeURIComponent(runId)}` : ''}`;
          const next = await fetchRuns<RunDetail>(`${base}?after=${cursor}&limit=500`, controller.signal);
          if (controller.signal.aborted) return;
          if (activeRun && activeRun !== next.run?.id) {
            cursor = 0; accumulated = []; omitted = 0; activeRun = next.run?.id ?? null;
            continue;
          }
          activeRun = next.run?.id ?? null;
          const ids = new Set(accumulated.map(event => event.id));
          accumulated = [...accumulated, ...next.events.filter(event => !ids.has(event.id))];
          if (accumulated.length > 1000) { omitted += accumulated.length - 1000; accumulated = accumulated.slice(-1000); }
          cursor = next.nextCursor;
          setData({ ...next, events: accumulated }); setOmittedEvents(omitted); setUpdatedAt(Date.now()); setError('');
          if (!next.hasMore) break;
        }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to read this run.'); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    refreshRef.current = () => { void read(); };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); refreshRef.current = () => {}; };
  }, [jobId, runId]);
  return { data, error, loading, updatedAt, omittedEvents, refresh: useCallback(() => refreshRef.current(), []) };
}
