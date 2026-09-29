# Start here: GitHub issue agent

This service turns GitHub issues into code-editing runs. A signed webhook enters a durable SQLite queue; a worker gives a model one just-bash tool and a separate checkout. Replies and reactions are delivered through a durable outbox. Follow-up `/agent` comments continue from that issue's last accepted commit.

## Documentation map

| Guide | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, offline demo, configuration, first live run. |
| [Local setup console](ui.md) | Edit the service environment file and run checks in the loopback console. |
| [Reach the local console over Tailscale](tailscale.md) | Keep the console bound to loopback while serving it over private tailnet HTTPS. |
| [Set up a GitHub App](github-app.md) | App registration, permissions, automatic token renewal, and optional manual helper. |
| [Everyday use and configuration](usage.md) | Issues, comments, filters, reviewing changes, configuration reference. |
| [Run observability and terminal replay](observability.md) | Attempt timelines, optional local asciinema recordings, privacy, storage, and exports. |
| [Operations and troubleshooting](operations.md) | Deployment, queue inspection, retries, backup, downtime, diagnostics. |
| [Tools and lifecycle hooks](extensions.md) | Add shell capabilities, durable feedback hooks, or a model adapter. |
| [Architecture](architecture.md) | Queue, leases, isolation, and durability boundaries. |
| [Verification](verification.md) | What has been tested and what remains unverified. |

## What is available now

- GitHub repository cloning; issue and issue-comment webhooks.
- Label and issue-author filters, concurrent workers, recovery and manual retries.
- just-bash file editing, composable commands, lifecycle comments and reactions.
- Local commits, binary patches, and transcripts for review.
- An always-on local attempt timeline, plus optional asciinema replay of completed command chunks.

Automatic branch pushes, pull requests, existing-issue backfill, and reaction-triggered runs are not implemented. GitHub App authentication mints and refreshes installation tokens on demand; a static `GITHUB_TOKEN` remains supported as a fallback. The CLI configures one repository per instance.

For a credential-free first look, run `npm ci` followed by `npm run demo` from the project directory. To also record the offline worker run and inspect it in the local console, use `npm run demo:recording`; the command prints the console startup command and Runs page URL. For live GitHub App operation, read the App guide before starting the service.
