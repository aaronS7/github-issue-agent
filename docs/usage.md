# Everyday use and configuration

## Start work from an issue

Open an issue in the configured repository describing the expected behavior, relevant files, and acceptance criteria. By default, `opened`, `reopened`, and `labeled` issue events start runs. No label or author filter is required, and bot-authored issues qualify.

Adding a label can therefore start another run even after the initial open event. To trigger only newly opened issues, set `ISSUE_ACTIONS=opened`. To opt into work with a label, for example:

```dotenv
ISSUE_ACTIONS=opened,reopened,labeled
ISSUE_LABELS=agent
```

An unlabeled opened issue is ignored; adding `agent` later starts a run. Existing labeled issues are not scanned or backfilled automatically. Event payloads are snapshots: removing a label after a job is accepted does not cancel that job.

## Continue through comments

Post a new comment starting with the configured prefix:

```text
/agent add a regression test for the empty-input case
```

The next run uses the issue and triggering comment, the previous completed run's summary, and its saved files. It does not fetch the entire comment history. Put the details needed for the next change in the triggering comment.

Only comment creation triggers runs; editing an old comment does not. Bot comments, marked agent replies, and pull-request comments are excluded. Prefix matching is a case-sensitive literal start-of-string check. With `/agent`, leading whitespace prevents a match; an empty `COMMENT_PREFIX` accepts every otherwise eligible comment.

Comments for the same issue queue behind earlier active/retrying jobs. Different issues can run concurrently. A failed attempt never becomes the starting point for a follow-up: the last accepted completed result does. Follow-ups preserve their existing issue branch; they do not automatically merge newer changes from the repository's base branch.

## Understand replies and reactions

With `GITHUB_FEEDBACK=true`, default lifecycle behavior is:

| Stage | Feedback |
| --- | --- |
| Started | Eyes reaction on the triggering issue or comment. |
| Successful | Rocket reaction and an issue comment containing the summary and local result information. |
| Retry scheduled | No default comment; see queue state and logs. |
| Final handled failure | Confused reaction and a failure comment. |

Reactions accumulate; the service does not remove the earlier eyes reaction. The model can also request a reply through `github-comment` or a reaction through `github-react`. Comments are posted to the issue conversation; reactions target the triggering comment when one exists. Feedback is delivered separately, so a completed job can still have pending or failed feedback.

A crash on the last permitted attempt can leave a dead job without a failure hook. Queue state is authoritative. Incoming reactions do not trigger work.

## Review and use the code changes

Run from the service project with the same `DATA_DIR` as the running process:

```sh
node --env-file-if-exists=.env dist/cli.js status
```

The JSON includes queue counts, up to 50 recent jobs and effects, and each successful job's `result`:

| Result field | Meaning |
| --- | --- |
| `workspace` | Checkout containing the edited files. |
| `gitDir` | Separate Git metadata and object directory. |
| `baseCommit` | Commit this attempt started from. |
| `commit` | Accepted result commit. |
| `patchPath` | Binary-capable patch from this attempt's base to its result. |
| `summary` / `changed` | Model explanation and whether files changed. |

The `artifacts` directory next to a checkout contains `result.json`, `changes.patch`, and `transcript.jsonl`. SQLite's `result` identifies the accepted attempt; do not choose an abandoned attempt merely because its files are newest.

After reviewing the patch, import the saved commit into another local checkout:

```sh
git -C /path/to/your/checkout fetch /absolute/path/from/result.gitDir COMMIT_SHA
git -C /path/to/your/checkout switch -c agent/issue-123 FETCH_HEAD
```

Substitute the actual `gitDir` and `commit` from status. This creates a review branch in your checkout. The complete commit history includes prior issue follow-ups. A follow-up's individual patch is incremental, so applying only that patch to the original base may omit earlier issue work. Push or create a pull request through your normal review workflow; this service does not do that automatically.

The sandbox checkout deliberately has no `.git` pointer. For Git inspection there, pass its external `--git-dir` and `--work-tree` explicitly, or use the fetched review branch.

## Inspect runs and recordings

The local console's **Runs** page separates queue state and GitHub feedback from each worker attempt. It shows a timeline of model calls, commands, capabilities, lifecycle changes, timing, exit outcomes, and token usage when reported. The timeline is always enabled and also includes failed attempts. Optional terminal replay is configured under **Configuration → Observability**; save the setting and restart the worker before it applies to new attempts.

Terminal replay uses local asciicast v2 files. It shows agent command scripts and completed output chunks, with timing and markers; it is not live terminal streaming and it does not capture keystrokes. Active attempts show a snapshot, which you can update with **Refresh recording**. The cast file can be downloaded or played with `asciinema play`. Recordings default off and are not uploaded to asciinema or another service. Review downloaded events and recordings before sharing because command output may contain repository data; known secrets are redacted on a best-effort basis. The separate `transcript.jsonl` artifacts retain raw command and final output and are not redacted by the observability recorder.

From the project directory, inspect the local ledger without GitHub credentials:

```sh
node --env-file-if-exists=.env dist/cli.js runs
node --env-file-if-exists=.env dist/cli.js inspect JOB_ID [RUN_ID]
```

See [Run observability and terminal replay](observability.md) for configuration bounds, storage location, exports, limits, and cleanup.

## Trigger settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_REPOSITORY` | Required | One `owner/repository` per CLI instance. |
| `ISSUE_ACTIONS` | `opened,reopened,labeled` | Comma-separated issue actions. |
| `ISSUE_LABELS` | Unset | Every listed label must be present. |
| `ISSUE_AUTHORS` | Unset | Allowed issue authors; it is not a commenter allowlist. |
| `COMMENT_PREFIX` | `/agent` | Literal prefix for a new comment. |
| `BOT_LOGINS` | Unset | Additional usernames to exclude, including user-based service accounts. |

Labels and author logins match case-insensitively. Author and label filters also apply to comment-triggered runs. Leave optional lists unset when unused: an explicitly empty author list matches no authors. `ISSUE_AUTHORS` does not restrict which human commenter may request a follow-up on an otherwise eligible issue.

## Worker and integration settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Queue, repository cache, checkouts, artifacts; prefer an absolute production path. |
| `ASCIINEMA_ENABLED` | `false` | Save optional local asciicast v2 recordings for new attempts. The event timeline remains on. |
| `ASCIINEMA_COLS` | `100` | Recording terminal width, 40–240 columns. |
| `ASCIINEMA_ROWS` | `28` | Recording terminal height, 10–100 rows. |
| `ASCIINEMA_MAX_BYTES` | `10485760` | Per-attempt cast limit, 65536–104857600 bytes (64 KiB–100 MiB). |
| `REPOSITORY_PATH` | Unset | Optional local Git repository instead of the managed GitHub clone. |
| `BASE_REF` | `HEAD` | Base for a first run on an issue; set a branch explicitly if the default changes. |
| `CONCURRENCY` | `2` | Active code workers per process, allowed range 1–64. |
| `LEASE_MS` | `60000` | Lease lifetime, at least 3000 ms; heartbeats renew it. |
| `MAX_ATTEMPTS` | `3` | Job and outbox retry budgets. |
| `MAX_STEPS` | `40` | Bash-call limit; each call in a batch counts. |
| `RUN_TIMEOUT_MS` | `600000` | Per-run deadline including repository preparation and finalization. |
| `GITHUB_FEEDBACK` | `true` | Enables default lifecycle feedback and model GitHub commands. |
| `GITHUB_APP_CLIENT_ID` | Unset | GitHub App client ID; set with the private key path to enable automatic App authentication. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Unset | Path to the App's RSA PEM private key; read and validated at startup. Requires `GITHUB_APP_CLIENT_ID`. |
| `GITHUB_APP_INSTALLATION_ID` | Unset | Optional positive numeric installation ID; otherwise discovered from the configured repository. |
| `GITHUB_TOKEN` | Unset | Static-token fallback when App client ID and key path are both unset. App settings take precedence. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | HTTP listener. |
| `MODEL_PROVIDER` | `anthropic` | `anthropic` or `openai-compatible`. |
| `MODEL` | Required | Provider model ID. |
| `MODEL_API_KEY` | Unset | Model credential; Anthropic can fall back to `ANTHROPIC_API_KEY`. |
| `MODEL_BASE_URL` | Provider default | Required for the compatible adapter. |
| `EXTENSIONS` | Unset | Trusted JavaScript module exporting capabilities, hooks, or a model factory. |

Configuration is read on startup; restart to apply changes or rotate the App key. With App authentication, the service requests repository-scoped Contents read permission and adds Issues write when `GITHUB_FEEDBACK=true`; when feedback is false it requests only Contents read. Tokens are cached in memory and refreshed on demand near expiry, so routine hourly restarts are unnecessary. `GITHUB_FEEDBACK=false` disables the built-in feedback hook and commands. Custom hooks and already queued effects may still be delivered; ensure the selected credential has the permissions those effects need. A private repository still needs cloning credentials when feedback is disabled, unless you use an accessible local clone via `REPOSITORY_PATH`.

See [App setup](github-app.md) for GitHub credentials and Enterprise endpoints, and [operations](operations.md) for recovery.
