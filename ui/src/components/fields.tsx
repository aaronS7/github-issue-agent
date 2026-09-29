import { useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { Eye, EyeOff, KeyRound, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from './primitives';
import type { Configuration } from '../lib/use-configuration';
import { fieldLabels } from '../lib/configuration';

export function Field({ id, label, hint, error, optional, children }:
  { id: string; label: string; hint?: ReactNode; error?: string; optional?: boolean; children: ReactNode }) {
  return <div className={`field${error ? ' field--error' : ''}`}>
    <label htmlFor={id}>{label}{optional && <span className="optional">Optional</span>}</label>
    {children}
    {(hint || error) && <p id={`${id}-hint`} className={error ? 'field-error' : 'field-hint'}>{error ?? hint}</p>}
  </div>;
}
export function SettingField({ config, name, label, hint, optional, ...props }:
  Omit<InputHTMLAttributes<HTMLInputElement>, 'name' | 'value' | 'onChange'> & {
    config: Configuration; name: string; label?: string; hint?: ReactNode; optional?: boolean;
  }) {
  return <Field id={name} label={label ?? fieldLabels[name] ?? name} hint={hint} optional={optional} error={config.errors[name]}>
    <input id={name} name={name} className="input" value={config.values[name] ?? ''} onChange={event => config.setValue(name, event.target.value)}
      aria-invalid={Boolean(config.errors[name])} aria-describedby={`${name}-hint`} spellCheck={false} autoComplete="off" {...props} />
  </Field>;
}
export function SecretField({ config, name, hint, action }:
  { config: Configuration; name: string; hint?: ReactNode; action?: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const value = config.secrets[name] ?? '';
  const stored = config.snapshot?.secrets[name];
  const cleared = config.secrets[name] === null;
  return <Field id={name} label={fieldLabels[name] ?? name} hint={hint} error={config.errors[name]}>
    <div className="secret-input"><KeyRound size={14} className="input-icon" aria-hidden="true" />
      <input className="input" type={visible ? 'text' : 'password'} id={name} autoComplete="new-password" spellCheck={false}
        value={value} placeholder={cleared ? 'Will be removed when saved' : stored ? 'Saved — leave blank to keep' : 'Enter a secret'}
        onChange={event => config.setSecret(name, event.target.value)} aria-invalid={Boolean(config.errors[name])} aria-describedby={`${name}-hint`} />
      <button type="button" className="input-action" disabled={!value} onClick={() => setVisible(!visible)} aria-label={visible ? `Hide ${fieldLabels[name]}` : `Show ${fieldLabels[name]}`}>
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
    <div className="secret-options"><span>{cleared ? 'Removal pending' : value ? 'New value · not saved' : stored ? 'Stored on this machine' : 'Not configured'}</span>
      <div className="inline-actions">{action}{stored && (cleared
        ? <Button variant="ghost" onClick={() => config.setSecret(name, undefined)}><RotateCcw size={12} />Keep saved</Button>
        : <Button variant="ghost" onClick={() => config.setSecret(name, null)} aria-label={`Remove saved ${fieldLabels[name]}`}><Trash2 size={12} />Remove</Button>)}</div>
    </div>
  </Field>;
}
export function Toggle({ checked, onChange, label, description, id }:
  { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; id: string }) {
  return <div className="toggle-row"><div><label htmlFor={id}>{label}</label>{description && <p id={`${id}-description`}>{description}</p>}</div>
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-description` : undefined}
      className={`toggle${checked ? ' toggle--on' : ''}`} onClick={() => onChange(!checked)} aria-label={label}><span /></button>
  </div>;
}
