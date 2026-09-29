import { useCallback, useEffect, useRef, useState } from 'react';
import type { Draft, Secrets, Snapshot, Validation, Values } from './configuration';

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors?: Record<string, string>) { super(message); }
}
async function request<T>(path: string, method = 'GET', body?: unknown, token?: string): Promise<T> {
  const response = await fetch(path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-CSRF-Token': token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin',
  });
  let json;
  try { json = await response.json(); } catch { throw new Error('The configuration server could not be reached.'); }
  if (!response.ok) throw new ApiError(json.error ?? 'The request could not be completed.', response.status, json.errors);
  return json as T;
}

export function useConfiguration() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [values, setValues] = useState<Values>({});
  const [secrets, setSecrets] = useState<Secrets>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'save' | 'validate' | 'github' | null>(null);
  const generation = useRef(0);
  const dirty = Boolean(snapshot && (JSON.stringify(values) !== JSON.stringify(snapshot.values) || Object.keys(secrets).length));
  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const next = await request<Snapshot>('/api/config');
      setSnapshot(next); setValues(next.values); setSecrets({}); setErrors({});
    } catch (e) { setLoadError(e instanceof Error ? e.message : 'Unable to load configuration.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const setValue = (key: string, value: string) => {
    generation.current++;
    setValues(current => ({ ...current, [key]: value }));
    setErrors(current => { const next = { ...current }; delete next[key]; return next; });
  };
  const setSecret = (key: string, value: string | null | undefined) => {
    generation.current++;
    setSecrets(current => { const next = { ...current }; if (value === undefined || value === '') delete next[key]; else next[key] = value; return next; });
    setErrors(current => { const next = { ...current }; delete next[key]; return next; });
  };
  const reset = () => { if (snapshot) { setValues(snapshot.values); setSecrets({}); setErrors({}); generation.current++; } };
  const draft = (): Draft => ({ values, secrets, revision: snapshot!.revision });
  const save = async () => {
    setBusy('save');
    try {
      const next = await request<Snapshot>('/api/config', 'PUT', draft(), snapshot!.csrfToken);
      setSnapshot(next); setValues(next.values); setSecrets({}); setErrors({});
    } catch (e) { if (e instanceof ApiError && e.errors) setErrors(e.errors); throw e; }
    finally { setBusy(null); }
  };
  const validate = async () => {
    setBusy('validate');
    try {
      const result = await request<Validation>('/api/validate', 'POST', draft(), snapshot!.csrfToken);
      setErrors(result.errors); return result;
    } finally { setBusy(null); }
  };
  const checkGitHub = async () => {
    setBusy('github');
    const start = generation.current;
    try {
      const result = await request<{ ok: boolean; message: string }>('/api/github/check', 'POST', draft(), snapshot!.csrfToken);
      return start === generation.current ? result : { ok: false, message: 'Settings changed during the check. Test the connection again.' };
    } finally { setBusy(null); }
  };
  return { snapshot, values, secrets, errors, loading, loadError, busy, dirty, load, setValue, setSecret, reset, save, validate, checkGitHub };
}
export type Configuration = ReturnType<typeof useConfiguration>;
