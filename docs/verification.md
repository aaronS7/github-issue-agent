# Verification

Verified locally on 2026-09-28 with Node v24.21.0 and Git 2.53.0.

| Check | Result |
| --- | --- |
| `npm run check` | Passed backend and React TypeScript checks. |
| `npm run build` | Passed; runnable JavaScript and declarations in `dist/`, React assets in `dist/ui/`. |
| `npm test` | Passed all 134 tests. |
| `npm run test:ui` | Passed all 9 Chromium browser tests against the built UI, local API, and recorded offline worker fixture. |
| `npm run cloudflare:check` | Passed Worker TypeScript checks and all 10 Worker tests. Install the deployment package's dependencies first. |
| `npm run cloudflare:dry-run` | Bundled successfully with the configured Queue and R2 bindings; no Cloudflare deployment. |
| `npm run demo` | Passed complete offline signed-webhook flow. |
| `npm run demo:recording` | Passed the same flow with local asciicast v2 recordings and readable attempt history. |
| Built CLI smoke check | Startup, health endpoint, signed webhook, background worker, SIGTERM, status, and backup passed. |
| CLI App authentication | RSA key loading, signed issue webhook, token discovery/minting, authenticated feedback, static-token precedence, and clean shutdown passed against a local API fixture. |

The tests exercise actual SQLite, Git, just-bash, and local HTTP servers. Model generation and GitHub HTTP responses use deterministic fixtures. The managed GitHub clone tests use a Git harness to inspect credential handling; the workspace tests run the real Git executable against local repositories.

Automatic App authentication is tested with signed JWT verification, repository and permission scoping, expiry and renewal, concurrent refresh requests, caller cancellation, token invalidation, failed refresh recovery, and sanitized errors. HTTP integration tests cover renewal between comment pagination and posting, bounded 401 retries, and static-token compatibility. Git tests cover fresh credentials for clone/fetch, authentication retry cleanup, independent cancellation for shared source work, and bounded retries. Runtime token minting and refresh have not been exercised with live GitHub credentials. The optional standalone helper remains covered for manual debugging and legacy static-token use.

## Durability coverage

- Jobs and delivery deduplication survive closing and reopening SQLite.
- Two queue connections cannot claim the same live job; events for one issue are ordered.
- A separate process is killed with SIGKILL after committing and claiming a job. Reopening recovers the job after the lease expires.
- Expired workers cannot renew, complete, publish a result, or insert feedback with their old ownership token.
- Completion records the result, issue head, and outbox effects in one transaction.
- Retrying an older dead job after a newer completed job advances the issue head correctly.
- Retries have backoff and attempt limits; dead jobs and feedback can be redriven.
- Online backup reopens with the expected data and refuses to overwrite an existing destination.

## Integration coverage

GitHub API polling tests cover persisted initial cutoffs, second-precision timestamps, updated older issues, label/author filters, comment prefix and bot handling, pagination failure recovery, SQLite reopen and deduplication, conditional requests, 401 token renewal, primary and secondary rate delays, long server-requested polling intervals, canonical repository casing, unsafe pagination/parent URL rejection, and cancellation. A subprocess CLI test completes a polled issue while the configured webhook port is occupied, with no webhook secret and incomplete Cloudflare settings. App token tests verify Issues read permission when polling with feedback disabled. Browser tests save polling settings, remove the webhook secret, and display the appropriate setup instructions.

Cloudflare tests cover raw-byte HMAC verification, repository filtering, body limits, private payload retrieval, sanitized failures, persist-before-queue ordering, and fail-closed configuration. The Worker-to-consumer integration test preserves a payload larger than the Queue's message limit, commits its job to real SQLite before acknowledgement, simulates a lost acknowledgement, then reopens SQLite and deduplicates redelivery. A CLI test exercises relay startup and clean shutdown. An actual local Wrangler development runtime with emulated Queue/R2 returned 202 for a signed issue, 200 with the exact payload bytes for authenticated retrieval, 401 for an invalid signature, and 503 for missing configuration. Temporary local bindings and secrets were removed afterward.

The offline demo processes one issue and one follow-up comment. It verifies duplicate issue delivery produces one job, actual just-bash edits fix the source, saved patches contain those edits, and the comment follow-up starts from the previous commit. Both jobs finish, and all seven feedback effects drain: three comments and four reactions. The source checkout remains intact for review.

The worker tests cover concurrent issues in separate checkouts and verify a GitHub feedback failure does not rerun completed code. HTTP tests cover raw-body signatures, malformed payloads, size limits, filters, bot-authored issues, and comment-loop prevention. Runtime tests cover symlink escape rejection, composable commands, multiple model tool calls, cancellation, and step limits.

The configuration API tests cover atomic environment-file saves, secret masking and removal, quoted and multiline values, preservation of unrelated configuration, concurrent save conflicts, required settings, origin and CSRF checks, static-file traversal, and GitHub App authentication with fixture responses. Browser tests cover editing across tabs, save/reload, masked secrets, connection checking, dialog keyboard behavior, draft discard, explicit secret removal, conflicting tabs, and mobile layouts. The UI's GitHub check has not been exercised with real credentials.

To run the browser checks on a new machine, install Chromium with `npx playwright install --with-deps chromium`, then run `npm run test:ui`. Browser fixtures use temporary environment files and an offline issue worker with a scripted model and local Git repository. They never call an external model or GitHub service.

## Observability coverage

Runtime tests cover durable attempt/event history, model and capability timing, reported token usage, retries, cancellation, explicit command-error events, best-effort recorder failure handling, encoded event size limits, known-secret redaction, and valid asciicast v2 output with normalized terminal line endings. Reader and HTTP tests cover legacy or absent databases, pagination, expired leases and interrupted attempts, run ownership, path/symlink rejection, partial recordings, metadata redaction, and JSONL export.

Browser tests exercise actual worker-generated traces and casts: enabling recordings and saving settings, retaining drafts across navigation, filtering failed jobs, viewing errors and feedback separately, play/pause, seeking, playback speed, player disposal on navigation, downloading casts, exporting events, and desktop/mobile layouts. A simulated read failure verifies polling retains the last good history and resumes without duplicate events. Playback runs under the production Content Security Policy without JavaScript or browser console errors.

The offline CLI `runs` and `inspect` commands also read the recorded demo history without model or GitHub credentials. Live byte streaming and physical power-loss durability of recording files are not claimed by these checks.

## Tailscale console access

The console's explicit HTTPS public URL is covered by four additional HTTP tests: matching Host/Origin and CSRF-protected saves, exact host/port/protocol checks, invalid public URLs, percent-encoded Host rejection, forwarded-header spoofing, and unchanged loopback defaults. All 104 backend tests and eight browser tests passed after this change.

The UI and configuration API were also verified through Tailscale Serve with certificate verification enabled. The UI loaded in a remote browser as a secure context; the config and validation APIs returned 200, and an untrusted Origin returned 403. These checks do not verify startup after reboot, issue-worker operation, or GitHub webhook delivery.

## Limits of this verification

No live model generation, live GitHub issue processing, real Cloudflare deployment, or physical power-loss test was performed. Live operation needs a configured repository, either complete App credentials or a static GitHub token, and model credentials. Webhook mode also needs a reachable ingress and matching secret; API polling needs no inbound endpoint. Queue durability relies on local storage honoring sync operations. GitHub comment delivery remains at least once; lookup-plus-post cannot provide an atomic exactly-once guarantee.

Changes are retained as local commits, patches, and transcripts. This implementation does not automatically push branches, open pull requests, backfill existing issues, or poll reactions. App token refresh is automatic during use, but it has not been tested against live credentials.
