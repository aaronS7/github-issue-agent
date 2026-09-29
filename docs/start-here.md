# Start here: GitHub issue agent

This service turns GitHub issues into code-editing runs. GitHub issues can enter a durable SQLite queue through signed webhooks or optional REST API polling; a worker gives a model one just-bash tool and a separate checkout. Replies and reactions are delivered through a durable outbox. Follow-up `/agent` comments continue from that issue's last accepted commit.

## Documentation map

| Guide | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, offline demo, configuration, first live run. |
| [Local setup console](ui.md) | Edit the service environment file and run checks in the loopback console. |
| [Reach the local console over Tailscale](tailscale.md) | Keep the console bound to loopback while serving it over private tailnet HTTPS. |
| [Deploy the Cloudflare webhook relay](cloudflare-relay.md) | Wrangler template, private R2 payloads, HTTP pull queue, secrets, and local configuration. |
| [Poll GitHub without webhooks](github-polling.md) | Private-host polling setup, first-run cutoff, snapshot behavior, and GitHub rate limits. |
| [Set up a GitHub App](github-app.md) | App registration, permissions, automatic token renewal, and optional manual helper. |
| [Everyday use and configuration](usage.md) | Issues, comments, filters, reviewing changes, configuration reference. |
| [Run observability and terminal replay](observability.md) | Attempt timelines, optional local asciinema recordings, privacy, storage, and exports. |
| [Operations and troubleshooting](operations.md) | Deployment, queue inspection, retries, backup, downtime, diagnostics. |
| [Tools and lifecycle hooks](extensions.md) | Add shell capabilities, durable feedback hooks, or a model adapter. |
| [Architecture](architecture.md) | Queue, leases, isolation, and durability boundaries. |
| [Verification](verification.md) | What has been tested and what remains unverified. |

## What is available now

- GitHub repository cloning; issue and issue-comment webhooks, or optional GitHub REST polling without a public endpoint.
- Optional Cloudflare webhook buffering with an outbound local consumer and SQLite deduplication.
- Label and issue-author filters, concurrent workers, recovery and manual retries.
- just-bash file editing, composable commands, lifecycle comments and reactions.
- Local commits, binary patches, and transcripts for review.
- An always-on local attempt timeline, plus optional asciinema replay of completed command chunks.

Automatic branch pushes, pull requests, historical backfill, and reaction-triggered runs are not implemented. Poll mode starts at its first-activation cutoff; open issues updated after that cutoff may qualify once. GitHub App authentication mints and refreshes installation tokens on demand; a static `GITHUB_TOKEN` remains supported as a fallback. The CLI configures one repository per instance.

For a credential-free first look, run `npm ci` followed by `npm run demo` from the project directory. To also record the offline worker run and inspect it in the local console, use `npm run demo:recording`; the command prints the console startup command and Runs page URL. For live GitHub App operation, read the App guide before starting the service.
