import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, X } from 'lucide-react';

export function Button({ variant = 'secondary', className = '', busy = false, children, disabled, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; busy?: boolean }) {
  return <button type="button" className={`button button--${variant} ${className}`} disabled={disabled || busy} {...props}>
    {busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{children}
  </button>;
}
export function Badge({ tone = 'neutral', children, dot = false }:
  { tone?: 'neutral' | 'success' | 'warning'; children: ReactNode; dot?: boolean }) {
  return <span className={`badge badge--${tone}`}>{dot && <span className="status-dot" />}{children}</span>;
}
export function Section({ title, description, action, children, footer, className = '' }:
  { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return <section className={`section ${className}`}>
    <header className="section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>
    <div className="section-body">{children}</div>
    {footer && <div className="section-footer">{footer}</div>}
  </section>;
}
export function Notice({ tone = 'neutral', children, ...props }:
  HTMLAttributes<HTMLDivElement> & { tone?: 'neutral' | 'success' | 'error' }) {
  return <div className={`notice notice--${tone}`} {...props}>{children}</div>;
}
export function ExternalLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-link" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={12} aria-hidden="true" /></a>;
}
export function CopyButton({ value, label = 'Copy', onError }: { value: string; label?: string; onError?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (copied) { const timeout = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timeout); } }, [copied]);
  return <Button className="copy-button" variant="ghost" aria-label={copied ? 'Copied' : label} title={failed ? 'Select and copy the text manually' : label} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setFailed(false); }
    catch { setFailed(true); onError?.(); }
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? 'Copied' : failed ? 'Copy unavailable' : label}</span></Button>;
}
export function CodeBlock({ value, label }: { value: string; label?: string }) {
  return <div className="code-block">{label && <div className="code-label">{label}</div>}<div className="code-line"><code>{value}</code><CopyButton value={value} /></div></div>;
}
export function Dialog({ open, onClose, title, description, children }:
  { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  return <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={onClose} onClick={event => {
    if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); }
  }}>
    <header className="dialog-header"><div><h2 id="dialog-title">{title}</h2>{description && <p>{description}</p>}</div><Button variant="ghost" onClick={onClose} aria-label="Close dialog"><X size={18} /></Button></header>
    {children}
  </dialog>;
}
