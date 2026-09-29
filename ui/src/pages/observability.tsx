import { Activity, ArrowUpRight, Clock3, Film, HardDrive, LockKeyhole } from 'lucide-react';
import { SettingField, Toggle } from '../components/fields';
import { Badge, CodeBlock, Section } from '../components/primitives';
import type { Configuration } from '../lib/use-configuration';

export function ObservabilityPage({ config }: { config: Configuration }) {
  const enabled = config.values.ASCIINEMA_ENABLED === 'true';
  return <>
    <Section title="Run timeline" description="See what happened, while it happens." action={<Badge tone="success" dot>Always on</Badge>}>
      <div className="policy-row"><Activity size={17} /><div><strong>Every attempt, including failures</strong><p>Model calls, commands, capabilities, and lifecycle changes.</p></div></div>
      <div className="policy-row"><Clock3 size={17} /><div><strong>Timing & outcomes</strong><p>Durations, exit codes, retries, and token usage when available.</p></div></div>
      <p className="field-hint">The Runs page refreshes every two seconds. It shows the job queue and GitHub feedback separately, so a failed comment does not look like a failed code change.</p>
      <a href="#runs" className="text-link">Open runs<ArrowUpRight size={13} /></a>
    </Section>
    <Section title="Terminal replay" description="Watch an agent’s commands in a playable terminal." action={<Film size={18} className="muted" />}>
      <Toggle id="ASCIINEMA_ENABLED" checked={enabled} onChange={value => config.setValue('ASCIINEMA_ENABLED', String(value))}
        label="Record with asciinema" description="Save a local .cast recording for each new attempt." />
      <p className="field-hint">Replay in the browser with play, pause, speed controls, and seeking. Recordings contain command scripts and completed output chunks. just-bash does not provide a live terminal byte stream.</p>
      {enabled && <div className="stack"><div className="field-grid"><SettingField config={config} name="ASCIINEMA_COLS" type="number" min={40} max={240} hint="Width of the recorded terminal." />
        <SettingField config={config} name="ASCIINEMA_ROWS" type="number" min={10} max={100} hint="Height of the recorded terminal." /></div>
        <SettingField config={config} name="ASCIINEMA_MAX_BYTES" label="Recording size limit (bytes)" type="number" min={65536} max={104857600} step={1024} hint="Default: 10 MiB per attempt. The timeline marks recordings that reach this limit." />
      </div>}
      <CodeBlock label="Play a downloaded recording with the asciinema CLI" value="asciinema play recording.cast" />
      <p className="field-hint">No asciinema account, external server, or recorder installation is needed for browser playback. Save and restart the bot to apply recording settings.</p>
    </Section>
    <Section title="Stored with your agent" description="Recordings and event history stay in your data directory.">
      <div className="policy-row"><HardDrive size={17} /><div><strong>Persistent local history</strong><p>Events in observability.sqlite; replay files in recordings/.</p></div></div>
      <div className="policy-row"><LockKeyhole size={17} /><div><strong>Local access, no automatic upload</strong><p>Known service secrets are redacted before new trace data is stored.</p></div></div>
      <p className="field-hint">Command output can include repository contents and other sensitive text. Redaction is best effort; review recordings before sharing. History is retained until you remove it.</p>
    </Section>
  </>;
}
