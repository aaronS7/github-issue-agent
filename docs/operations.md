# Operations and troubleshooting

## Deploy the service

Install the project and dependencies, run `npm run build`, and run the service as a dedicated account. The checked-in `examples/issue-agent.service` assumes:

| Setting | Example value |
| --- | --- |
| Service account | `issue-agent` |
| Project directory | `/opt/github-issue-agent` |
| Environment file | `/etc/github-issue-agent.env` |
| Persistent data directory | Set `DATA_DIR=/var/lib/github-issue-agent` in that environment file. |
| Node executable | `/usr/bin/node`; adjust for your Node 24 installation. |

Create the account and directories for your host, grant the service write access to its data directory, and put the configuration in the environment file. Then, from the project directory:

```sh
sudo install -m 644 examples/issue-agent.service /etc/systemd/system/issue-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now issue-agent
sudo systemctl status issue-agent
sudo journalctl -u issue-agent -f
```

Systemd's environment file is distinct from an interactive shell's `.env`. For the admin commands below, make it readable by the dedicated service group as well as root:

```sh
sudo chown root:issue-agent /etc/github-issue-agent.env
sudo chmod 640 /etc/github-issue-agent.env
```

Keep that group limited to the service account and trusted operators. With App authentication, the process reads the key at startup and mints installation tokens as GitHub requests need them. Keep the key path readable by the service account and restart after changing the key or App settings. A static `GITHUB_TOKEN` fallback still needs manual replacement when it expires.

Expose the webhook through an HTTPS reverse proxy. Keep the raw request body unchanged so its HMAC verifies. The receiver accepts at most 1 MiB; configure a compatible proxy body limit. `GET /healthz` checks the listener/database only, not GitHub connectivity, token validity, or model health.

The setup console is a separate loopback service. To make it available over private tailnet HTTPS, follow [Reach the local console over Tailscale](tailscale.md). That private URL cannot receive GitHub webhooks; expose the webhook receiver separately.

## Inspect and recover work

For the systemd deployment above, define this shell helper. It uses the service's actual account and configuration, so you inspect the same queue:

```sh
agent-admin() {
  sudo -u issue-agent /usr/bin/node --env-file=/etc/github-issue-agent.env /opt/github-issue-agent/dist/cli.js "$@"
}
agent-admin status
agent-admin retry 12
agent-admin retry-outbox 25
```

For a local development process launched with `npm start`, use `node --env-file-if-exists=.env dist/cli.js` in the project directory instead of `agent-admin`. Use absolute deployment paths in `/etc/github-issue-agent.env`.

Use actual job/effect IDs from `status`. `queued` waits for a worker or retry delay; `running` has a lease; `done` completed; `dead` exhausted attempts. Retry commands only accept dead entries and reset their attempt budget. `retry-outbox` delivers failed feedback without running the model again.

Fix the underlying credential, model, repository, or capability error before retrying. Inspect `lastError`, JSON service logs, and the attempt's `transcript.jsonl`. The transcript records the script, bounded output, and exit code for each bash call; model final text is also recorded.

For the attempt event timeline and optional asciinema recording, use the console's **Runs** page or the read-only CLI commands `agent-admin runs` and `agent-admin inspect JOB_ID [RUN_ID]`. Capture errors are logged as `observability-error`; capture is best effort and does not cause a job retry. See [Run observability and terminal replay](observability.md) for event and recording limits, redaction, export, and cleanup details.

Workers recover abandoned jobs after lease expiry and exponential backoff, starting at one second. A stopped or crashed worker can therefore leave a job briefly marked `running`. An issue's earlier retrying job blocks later events for that issue; other issues remain eligible.

`SIGINT` and `SIGTERM` stop intake and abort active runs. Those attempts can retry if budget remains. For planned maintenance, waiting for zero running jobs avoids interrupting work. Do not delete attempt directories as a recovery step: future comments may depend on their Git objects.

## Recover deliveries missed during downtime

GitHub does not automatically redeliver a failed webhook. Inspect the App's delivery history and request redelivery after restoring the endpoint. Accepted delivery IDs are deduplicated. GitHub describes its recovery options in [handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

If you saved a raw GitHub payload, you can ingest it locally:

```sh
agent-admin replay issues ORIGINAL_DELIVERY_ID /absolute/path/to/issue-payload.json
agent-admin replay issue_comment ORIGINAL_DELIVERY_ID /absolute/path/to/comment-payload.json
```

Use the original event name and delivery ID. This trusted local admin command bypasses HTTP signature verification but still applies normalization, repository, and trigger filters. It does not query GitHub for missing events or reconstruct payloads. A payload already accepted under that ID returns the same job.

## Back up and restore

Create a consistent queue backup while the service is running:

```sh
agent-admin backup /backups/issue-queue-snapshot.sqlite
```

The destination must be new and its directory writable by the service account. This uses SQLite's online backup API and backs up the queue only. Keep the run directories too: queue results reference saved Git metadata and commits. It also does not back up `observability.sqlite` or optional cast recordings. For a consistent full backup, stop the service and snapshot/copy the entire `DATA_DIR`, then restart. Preserve the protected deployment configuration separately.

Restore to the same absolute data path, or migrate the stored result paths before running; queue records contain absolute workspace/Git paths. Restore a queue snapshot together with its matching run artifacts and observability data. Never pair a restored queue with stale `observability.sqlite` or `recordings/` data from a different queue: job IDs can be reused, which can make old traces appear to belong to new jobs. If you restore only the queue, remove the mismatched observability database and recordings instead of reusing them. Never mix a database backup with a WAL from a different snapshot. Copying only a live `queue.sqlite` can omit committed WAL data. SQLite documents [WAL behavior](https://sqlite.org/wal.html) and [sync settings](https://sqlite.org/pragma.html#pragma_synchronous).

The queue uses WAL and `synchronous=FULL` on local storage. Acknowledged jobs are intended to survive crashes and power loss when the filesystem/device honors sync. The tests demonstrate process termination and reopen behavior; they are not a hardware power-cut qualification. Network filesystems are not suitable for this WAL deployment.

## Troubleshooting

| Symptom | Check and next action |
| --- | --- |
| Webhook 401 | App secret and `GITHUB_WEBHOOK_SECRET` must match; proxy must preserve body bytes. This is separate from token expiry. |
| Webhook 404 | Use `POST /webhooks/github` exactly, with the proxy forwarding the path. |
| Webhook 413 | Payload exceeds the receiver's 1 MiB limit. |
| Webhook 503 | Inspect database/disk availability and service logs, then redeliver. |
| HTTP 202 but no job | Inspect `ignored:true`: repository/action/filter mismatch, unprefixed comment, bot comment, PR event, malformed payload, or harmless `ping`. |
| GitHub REST 401 or explicit Git authentication rejection | App authentication refreshes and retries once. Check the App key, installation, repository access, and service logs. A clone/fetch 404, permission denial, or network failure does not trigger an auth retry; inspect the underlying repository or connectivity issue. Failures then follow the normal job retry behavior. Static tokens must be replaced manually when expired. |
| GitHub 403 | Check installed permissions, organization approval, rate limits, and the App installation status. |
| Installation lookup or token minting fails | Check repository spelling, installation account, selected repositories, App key/client ID pair, and that the installation accepted current permissions. An explicit installation ID must be positive and belong to this App/repository. |
| JWT authentication fails | Check the PEM/client ID pair and host clock. An OAuth client secret cannot sign an App JWT. |
| Job done, no comment | Inspect outbox entries, token, and Issues write permission. Retry the effect after fixing the error. |
| No attempt timeline or cast appears in Runs | Confirm the console reads the worker's saved `DATA_DIR`; inspect logs for `observability-error`. The timeline is always attempted. Casts require `ASCIINEMA_ENABLED=true` and a worker restart. |
| `node`, `npm`, or `git` unavailable inside agent | Expected: just-bash has no arbitrary host binaries. Add a deliberate validation capability. |
| Service says set a model/key | Configure the model adapter or provide a trusted `createModel` extension. GitHub authentication is not model authentication. |
| Multiple service instances show unexpected jobs | Verify each intended repository has the correct `DATA_DIR` and `GITHUB_REPOSITORY`. Per-process concurrency adds across processes. |
| Old issue ignored | There is no automatic backfill. Reopen it, add a qualifying label, post a new qualifying comment, or replay its saved event. |

Outgoing feedback remains at least once. Comment markers reconcile normal retries, but an external POST cannot participate in SQLite's completion transaction, so a narrow duplicate-comment race remains possible. See [architecture](architecture.md) and [verification](verification.md) for those boundaries.
