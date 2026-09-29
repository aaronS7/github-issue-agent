# GitHub issue agent

A GitHub issue starts a code-editing agent whose only model tool is **just-bash**. The service clones the configured GitHub repository, queues work in durable SQLite, and runs a bounded number of agents. Each run produces a local commit, binary patch, and transcript. `/agent` comments start follow-up runs from that issue's last completed commit.

GitHub comments and reactions use a separate durable outbox. You can compose additional tools as just-bash commands and return feedback from lifecycle hooks.

See the [documentation index](docs/start-here.md) for setup, daily usage, operations, extensions, a step-by-step [GitHub App guide](docs/github-app.md), and [polling GitHub without webhooks](docs/github-polling.md).

The local console includes a **Runs** page with an always-on event timeline and optional local asciinema replay of agent command chunks. Recordings default off and playback is a snapshot; see the [observability guide](docs/observability.md) for configuration, limits, privacy, and exports.

## Configure in the local console

Run `npm run ui` to build and start the loopback-only setup console at `http://127.0.0.1:3100`. It edits the selected `.env` file and provides configuration and optional live GitHub checks; restart the service after saving. See the [setup console guide](docs/ui.md) for development commands, secret handling, and check behavior.

For a public webhook that accepts deliveries while the agent host is offline, use the optional [Cloudflare relay template](deploy/cloudflare/README.md). A Worker verifies GitHub signatures, stores raw payloads in private R2, and queues delivery pointers. The local service pulls over HTTPS and acknowledges messages after SQLite persistence. The [deployment guide](docs/cloudflare-relay.md) includes Wrangler commands and a handoff for another coding agent; direct webhooks remain available.

## Try it without credentials

Requires **Node 24+** and **Git 2.36+** on Linux or macOS.

```sh
npm ci
npm run demo
```

The demo creates a temporary repository, receives a signed issue webhook twice, deduplicates it, fixes a bug with actual just-bash file commands, saves a commit and patch, and handles a follow-up comment. A scripted model and local GitHub API fixture make this repeatable without external requests. The final output includes the retained artifacts.

To also save and inspect an asciinema recording from the offline worker, run `npm run demo:recording`. It prints a command to launch the local console against the retained demo data and the Runs page URL. See the [observability guide](docs/observability.md) for details.

```sh
npm run check
npm run build
npm test
```

Tests cover HTTP signatures, malformed events, filters, concurrent deliveries, SQLite reopen, actual process termination with `SIGKILL`, stale lease rejection, retries, separate checkouts, model tool calls, follow-up edits, and GitHub feedback replay.

## Connect GitHub

1. Copy `.env.example` to `.env` and set `GITHUB_REPOSITORY=owner/repository`. The default `GITHUB_EVENT_SOURCE=webhook` requires a random `GITHUB_WEBHOOK_SECRET`. For GitHub App authentication, set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY_PATH`; optionally set `GITHUB_APP_INSTALLATION_ID` to a positive numeric installation ID. Otherwise the service discovers the installation for the configured repository. A static `GITHUB_TOKEN` remains supported as a fallback. To use polling instead, set `GITHUB_EVENT_SOURCE=poll`; a GitHub App or token is required for Issues read access. Polling does not need a webhook secret or public endpoint. See [polling setup and limits](docs/github-polling.md).
2. Set `MODEL_PROVIDER`, `MODEL`, and `MODEL_API_KEY`. The included adapters support Anthropic and a provider with a compatible chat-completions API (`MODEL_PROVIDER=openai-compatible` plus `MODEL_BASE_URL`). Model selection is independent of the GitHub integration.
3. Run `npm run build && npm start`. In webhook mode, put an HTTPS reverse proxy in front of the listener; the default bind address is `127.0.0.1:3000`. Poll mode does not start that listener and needs no public endpoint.
4. In webhook mode, set the GitHub App's webhook URL to `https://your-host/webhooks/github`, content type to `application/json`, and the same secret. Subscribe to **Issues** and **Issue comments**. In poll mode, leave App webhook delivery inactive and skip this step.
5. Open an issue. Use a comment starting with `/agent` for a follow-up. In webhook mode, `GET /healthz` reports whether the listener and database are reachable; poll mode has no HTTP listener or health endpoint.

In webhook mode, opened, reopened, and labeled issues qualify without a label or author restriction. Bot-authored issues also qualify. Bot comments and comments containing the agent's output marker are ignored to prevent reply loops. Poll mode instead schedules eligible open issues once from its first-activation cutoff. Set `BOT_LOGINS` when using a regular user account as the bot, including for commands posted outside this service.

`BASE_REF=HEAD` uses the repository's default branch when its managed source is cloned. Set `BASE_REF=main` (or another branch) explicitly if needed. `REPOSITORY_PATH` optionally supplies an existing local repository instead of cloning GitHub. Local uncommitted changes are not included. Submodules and Git LFS downloads are not initialized.

This version keeps completed changes as **local review artifacts**; it does not push branches or open pull requests. The completion comment reports the local commit. To bring a result into your own checkout, inspect its patch and fetch its saved commit:

```sh
# Find result.gitDir, result.commit, and result.patchPath in status output.
node --env-file-if-exists=.env dist/cli.js status
git -C /path/to/your/checkout fetch /absolute/path/from/result.gitDir COMMIT_SHA
git -C /path/to/your/checkout switch -c agent/issue-123 FETCH_HEAD
```

## Configure triggers and concurrency

| Setting | Default | Behavior |
| --- | --- | --- |
| `GITHUB_EVENT_SOURCE` | `webhook` | Choose `webhook` or `poll`; poll mode needs GitHub Issues read access and does not start the HTTP webhook listener. |
| `GITHUB_POLL_INTERVAL_MS` | `60000` | Poll interval in milliseconds, 10000–3600000 (10 seconds–1 hour). |
| `ISSUE_ACTIONS` | `opened,reopened,labeled` | Issue webhook actions that start runs; ignored in poll mode, where eligible open issues are presented as `opened`. |
| `ISSUE_LABELS` | unset | Comma-separated labels; all must be present. |
| `ISSUE_AUTHORS` | unset | Comma-separated allowed **issue authors**. Also applies to follow-up comments. |
| `COMMENT_PREFIX` | `/agent` | Required prefix for new comments. Empty accepts every non-bot comment. |
| `BOT_LOGINS` | unset | Additional service-account logins to ignore. |
| `CONCURRENCY` | `2` | Number of active code agents per service process. |
| `LEASE_MS` | `60000` | Ownership lifetime, renewed every third of this interval. |
| `MAX_ATTEMPTS` | `3` | Attempt limit for jobs and outbox entries. |
| `MAX_STEPS` | `40` | Maximum bash calls per run. |
| `RUN_TIMEOUT_MS` | `600000` | Deadline for a complete run. |
| `GITHUB_FEEDBACK` | `true` | Enable default lifecycle feedback and GitHub commands. |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | Unset | Enable automatic GitHub App installation-token authentication when both are set. App credentials take precedence over `GITHUB_TOKEN`. |
| `GITHUB_APP_INSTALLATION_ID` | Unset | Optional positive numeric installation ID; otherwise discovered for `GITHUB_REPOSITORY`. |
| `DATA_DIR` | `./data` | Durable queue, repository cache, and run artifacts. |
| `ASCIINEMA_ENABLED` | `false` | Save optional local asciicast v2 recordings for new attempts; the event timeline remains enabled. |
| `ASCIINEMA_COLS` / `ASCIINEMA_ROWS` | `100` / `28` | Recorded terminal dimensions (columns 40–240; rows 10–100). |
| `ASCIINEMA_MAX_BYTES` | `10485760` | Per-attempt recording limit, 65536–104857600 bytes. |

Webhook deliveries and poll results are processed in local arrival order per repository/issue. A retry blocks later work for that issue until it succeeds or reaches the attempt limit. Other issues can run concurrently. Webhook label changes can queue another run; polling schedules each eligible issue once, while a new matching `/agent` comment requests a follow-up.

Events are snapshots: the agent sees the issue and triggering comment, plus the previous completed run's summary and files. Historical comments are not fetched. Polling sets a first-activation cutoff rather than backfilling old issues/comments, though an older open issue updated after that cutoff can qualify once. Polling observes REST snapshots and cannot promise GitHub's original event chronology. GitHub reactions are outgoing feedback; they do not trigger runs.

## Add tools and lifecycle hooks

Set `EXTENSIONS=./examples/extensions.mjs` to load trusted service code. The example adds `project-info`, a command that reads `package.json`, and a completion reaction. The model still has a single `bash` tool; commands compose with pipes, redirection, and built-in just-bash commands.

An extension exports any of:

```js
export default {
  capabilities: [{ name, description, create: ({ signal, assertActive }) => command }],
  hooks: [({ phase, job, issue, summary, commit, changed }) => effects],
  createModel: (job, issue) => modelAdapter,
};
```

- Capabilities use `defineCommand` from just-bash. Call `await assertActive()` immediately before any external side effect, and honor `signal`. Trusted extensions run in the host process; keep them outside agent-writable directories.
- Hook phases are `started`, `succeeded`, `retrying`, and `failed`. Hooks return arrays of `{kind: 'comment' | 'reaction', key, payload}`. Give each effect a stable key; perform network I/O in the outbox, not inside a hook. An abrupt crash on the final attempt can leave a dead job without invoking a failure hook; inspect queue status for these cases.
- Comment payloads are `{repository, issueNumber, body}`. Reaction payloads are `{repository, issueNumber, content, commentId?}`; `commentId` targets the triggering comment.
- Model adapters implement `complete(messages, signal)` and return `{script}` for one bash call, `{scripts}` for several sequential calls, or `{text}` for the final response. Every call counts against the step limit. `ScriptedModel` supports deterministic tests.

Built-in capability commands are `agent-tools`, `github-comment` (argument or stdin), and `github-react` (a supported GitHub reaction). Feedback commands are installed when `GITHUB_FEEDBACK=true`.

The sandbox has no Git executable, package manager, arbitrary host shell, network, Python, or JavaScript execution enabled. Code validation requiring real binaries needs an explicit capability backed by an appropriate isolated runner. File reads/writes use a dedicated checkout with symlinks denied and Git metadata outside the sandbox. just-bash limits execution and output; it is not an OS boundary or a disk quota. Run the service with appropriate disk and process limits for the repositories you accept.

## Durability and operations

The queue uses SQLite **WAL + `synchronous=FULL`**, explicit transactions, atomic claims, and random lease tokens. A webhook is acknowledged only after its job commits. An accepted delivery survives process termination; abandoned attempts recover when their lease expires. Retries use exponential backoff starting at one second. Completion records the accepted result and lifecycle feedback in one transaction. Each attempt has a unique checkout, so expired agents cannot overwrite replacement attempts.

Outbox delivery has its own lease, retry count, and dead state. A failed comment does not rerun a successful code change. Stable comment markers reconcile a successful GitHub POST when the worker crashes before acknowledging it locally. Delivery is **at least once**, not exactly once: GitHub's comment API has no transactional idempotency key, so a narrow concurrent POST race can still duplicate comments. Reactions and repeated capability requests also use stable effect keys.

Store `DATA_DIR` on a persistent **local** filesystem. SQLite WAL is not suitable for a shared network filesystem. Hardware and filesystem sync behavior determine power-loss durability; the test suite checks process crashes and reopening, not physical power failure. Keep all run artifacts: later comments can depend on their Git objects. No automatic pruning is enabled.

```sh
node --env-file-if-exists=.env dist/cli.js status
node --env-file-if-exists=.env dist/cli.js retry 12
node --env-file-if-exists=.env dist/cli.js retry-outbox 25
node --env-file-if-exists=.env dist/cli.js backup /backups/queue-2026-09-27.sqlite
node --env-file-if-exists=.env dist/cli.js replay issues DELIVERY_GUID ./payload.json
```

`retry` and `retry-outbox` accept dead entries and reset their attempt budget. The backup command uses SQLite's online backup API and refuses to overwrite a destination. It backs up the queue only; preserve run artifacts separately. Stop the service for a consistent full-directory backup. Do not copy only `queue.sqlite` while a live WAL exists.

GitHub **does not automatically redeliver failed webhooks**. After downtime, redeliver failures through GitHub or replay saved payloads using their original delivery IDs. Queue durability starts when this service has accepted an event. Put the service under a supervisor with automatic restart, such as the included systemd example. `SIGINT`/`SIGTERM` stop intake and abort active runs; those jobs can retry on restart.

See [the architecture notes](docs/architecture.md) for the design and primary references.
