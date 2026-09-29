# Run observability and terminal replay

The local console's **Runs** page shows the queue and the work performed by each attempt. The event timeline is always enabled. Optional asciinema recordings add a playable, downloadable view of agent commands and completed command output.

Observability is a local diagnostic record. It does not change job decisions: the durable queue remains the authority for job state, and a timeline or recording failure is logged without retrying completed work.

## What the timeline contains

Each attempt has a record in `DATA_DIR/observability.sqlite`, alongside the queue database. The database uses SQLite WAL mode with `synchronous=FULL`. The ledger stores attempt status and phase, timestamps, summary and error text, bash call counts and durations, model call counts and durations, reported token usage when the model supplies it, and ordered events for model calls, commands, capabilities, and lifecycle changes. GitHub queue and feedback statuses are shown separately from attempt outcomes. Command metrics include failed or interrupted commands.

The timeline is recorded whether terminal replay is enabled or not. Each attempt is independent, including retries and failures. The event ledger has per-attempt bounds of 10,000 events and 10 MiB of encoded event data; an individual event payload is capped at 16 KiB. When a limit is reached, the UI marks the trace as truncated. A capture limit does not stop the agent.

## Optional asciinema recording

Recordings use asciicast v2 (`.cast`) and live under `DATA_DIR/recordings/`. They are written as the attempt runs. The player shows command scripts, completed stdout and stderr chunks, summary text, and labeled phase/outcome markers with approximate timing. Idle pauses are capped at two seconds.

This is a replay assembled from agent events. It is not a live PTY or byte-for-byte terminal capture: just-bash does not expose a live terminal stream, and the recording contains no keystrokes or terminal input. ANSI escape sequences and other control characters are removed before recorded text is stored. New recordings are local; the application does not upload them and does not require an asciinema account, hosted service, or recorder installation. Browser playback uses the bundled player.

Enable recordings in **Configuration → Observability**. Save the configuration and restart the worker; settings apply to attempts started after that restart. `ASCIINEMA_ENABLED` defaults to `false`. Terminal dimensions default to 100 columns by 28 rows. The size limit defaults to 10 MiB per attempt; accepted values are 64 KiB through 100 MiB.

| Setting | Default | Accepted values | Purpose |
| --- | --- | --- | --- |
| `ASCIINEMA_ENABLED` | `false` | `true` or `false` | Write a local `.cast` file for each new attempt. |
| `ASCIINEMA_COLS` | `100` | 40–240 | Width recorded in the cast header. |
| `ASCIINEMA_ROWS` | `28` | 10–100 | Height recorded in the cast header. |
| `ASCIINEMA_MAX_BYTES` | `10485760` | 65536–104857600 | Maximum cast file size per attempt, in bytes. |

The Runs page offers playback, a **Playback speed** menu (0.5×, 1×, 1.5×, or 2×), an explicit **Refresh recording** action while an attempt is active, and a `.cast` download. Playback loads a snapshot. While the attempt is active, it does not poll for new recording bytes; use the refresh action to load a newer snapshot. When the attempt finishes, the player loads one final snapshot automatically. Completed command chunks appear as they finish, so no live command output is promised. Downloads of a recording that is still growing or otherwise incomplete are marked partial. Reaching the configured size limit also marks the recording partial; the job continues.

You can also play a downloaded file with the asciinema CLI:

```sh
asciinema play recording.cast
```

To exercise the recording flow without credentials or external services, run the offline worker demo with recording enabled:

```sh
npm run demo:recording
```

It creates a temporary repository and data directory, runs the scripted just-bash worker, verifies a v2 cast was saved, and prints the temporary paths plus a command to start the console and a Runs-page URL. Run the printed console command to inspect the generated run and replay. The demo leaves its temporary files available for inspection; remove the printed temporary directory when you no longer need it.

## Read, inspect, and export

The console is served locally. Its Runs page polls queue and timeline data every two seconds while the page is visible, with a manual refresh control. The page retains up to the latest 1,000 loaded events in the browser; use **Export events** to download the captured event history as JSON Lines. The export has a bounded size. A separate download link returns the cast file, including a partial snapshot if a recording is still being written.

For terminal access, run these commands from the service project with the same `DATA_DIR` as the worker:

```sh
node --env-file-if-exists=.env dist/cli.js runs
node --env-file-if-exists=.env dist/cli.js inspect JOB_ID
node --env-file-if-exists=.env dist/cli.js inspect JOB_ID RUN_ID
```

`runs` lists jobs with their attempt summaries and whether a recording is available. `inspect` prints the selected attempt and up to its first 200 timeline events. It works without GitHub or model credentials. For service deployments, see [operations](operations.md) for an `agent-admin` helper that uses the service account and environment file.

The read-only console endpoints are available at `GET /api/runs`, `GET /api/runs/JOB_ID`, and `GET /api/runs/JOB_ID/attempts/RUN_ID`. Add `/events.jsonl` to the attempt route to export events, or `/recording` to download its cast file. These routes read the configured local data directory; run the console only where its operator access is appropriate.

## Privacy, storage, and cleanup

Trace strings and recording text are passed through best-effort redaction for configured GitHub and model secrets, and terminal escape/control sequences are stripped from recorded text. Redaction only knows configured secret values; it cannot recognize every credential, private file, or other sensitive value that a command might print. The existing per-run `transcript.jsonl` artifact is separate and retains raw command and final output; the observer's redaction does not scrub that transcript. Summaries, errors, scripts, transcripts, and output can contain repository data. Review them before sharing.

The observability database and recordings stay in `DATA_DIR`; the application has no automatic retention or pruning. Plan disk capacity for the queue, run artifacts, database, and any enabled recordings. The recording byte cap is per attempt, not a global data-directory quota. Keep these files within the same access controls as the service's other run data. They are included when backing up the complete data directory; the queue-only `backup` command does not include them. To remove diagnostic history, stop the service and remove `observability.sqlite`, its `observability.sqlite-wal` and `observability.sqlite-shm` files if present, and the `recordings/` directory. This also deletes timeline and replay history; keep a backup first if you need it.

An observability database or recording write error is logged as `observability-error`. The worker continues the run, and the job is not retried because capture failed. Missing history can therefore mean observability data was unavailable or a capture limit was reached; check the worker logs and the truncation indicators.

[Back to documentation index](start-here.md)
