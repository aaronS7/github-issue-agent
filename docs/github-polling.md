# Poll GitHub issues without webhooks

Polling is an optional way to find eligible issues and `/agent` follow-up comments when the service host cannot receive GitHub webhooks. It uses the GitHub REST API from the service host. The service does not open a public listener in poll mode, and this mode does not require a GitHub webhook URL or `GITHUB_WEBHOOK_SECRET`. The optional [Cloudflare webhook relay](cloudflare-relay.md) is a separate webhook transport; polling does not need it.

## Configure

Install a GitHub App on the repository as described in [Set up a GitHub App](github-app.md), and configure its client ID and private key on the service host. The App needs **Issues: read** to discover issues and comments. If `GITHUB_FEEDBACK=true`, it also needs **Issues: write** to post replies and reactions. The service renews installation tokens automatically while running. For a polling-only deployment, leave App webhook delivery inactive; no webhook URL or secret is needed. A static `GITHUB_TOKEN` with the same repository permissions is also supported, but an App is preferred.

Set these values in the service environment:

```dotenv
GITHUB_REPOSITORY=owner/repository
GITHUB_EVENT_SOURCE=poll
GITHUB_POLL_INTERVAL_MS=60000
GITHUB_APP_CLIENT_ID=your-app-client-id
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/private/path/issue-agent.pem
# Optional; omit to discover the installation for GITHUB_REPOSITORY
# GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_FEEDBACK=true
# Alternative to App credentials: an installation token/PAT with Issues read,
# and Issues write when feedback is enabled. App credentials take precedence.
# GITHUB_TOKEN=your-token
```

The polling interval defaults to 60,000 ms and accepts 15,000–3,600,000 ms (15 seconds to 1 hour). Start with the default. Run one poller for each repository and `DATA_DIR`; multiple pollers make redundant API calls. Restart the service after changing the environment. For example, when using the supplied systemd unit:

```sh
sudo systemctl restart issue-agent
```

`GITHUB_EVENT_SOURCE` defaults to `webhook`, so existing installations keep webhook behavior. In poll mode the local webhook listener is not started. Leave `GITHUB_WEBHOOK_SECRET` unset if there is no other webhook input configured. The existing Cloudflare relay template is for webhook delivery; polling needs no Worker, Queue, R2 bucket, or inbound public connection. Keep the local UI private on Tailscale.

## What polling sees

On first activation, the poller records a cutoff at the current time, rounded down to GitHub's second-precision timestamps. It does not backfill older issues or comments, though an item from that same second may be observed. It checks open issues updated since that cutoff and presents each eligible issue as an `opened` event, then applies the configured issue label, author, and bot filters. `ISSUE_ACTIONS` applies only to webhook events and is ignored in poll mode. An issue that becomes eligible later, for example when someone adds a required label, can be picked up on a later poll. Each issue is scheduled once using a stable ID, so later edits to the issue, reopening it, or feedback posted by the service do not automatically start another run. Each matching comment ID is queued once. A new `/agent` comment can request a follow-up on an open or closed issue. A comment created after activation can qualify if it is edited to start with `/agent` before the poller first queues it; edits to an already queued comment do not request another run, and comments created before the activation cutoff are ignored even if later edited. The comment prefix and bot filters apply to new comments.

Polling reads the current REST API snapshot; it cannot reconstruct every intermediate change between polls. An issue may be opened and closed between snapshots without being seen, and several updates may be observed only in their final state. Each feed scan is limited to 50 pages (up to 5,000 items). If a scan exceeds that limit, it fails without advancing its cursor; the poller cannot make progress until the page cap or pending scan is addressed. Processing follows the local poll/queue arrival order, not a guaranteed reconstruction of GitHub's event chronology. Use webhook mode when delivery of individual GitHub events is important.

The cutoff, poll cursor, queue, and delivery deduplication state are stored in the main SQLite database. Keep that database in the service's persistent `DATA_DIR`; include it in the normal stopped-service backup described in [Operations](operations.md). A service restart reuses its saved cursor. If the database is lost, a new cutoff is established at startup, and the service will not automatically discover all work from the missing interval.

## Rate limits and request volume

GitHub recommends webhooks instead of polling when webhooks are available. This polling mode uses a fixed schedule, stable queries with ETags, and `If-None-Match` conditional requests. An authenticated `304 Not Modified` response does not count against the primary REST rate limit, though requests can still be subject to secondary rate limits. The poller honors GitHub's poll interval and rate-limit/retry headers, including `x-poll-interval`, `Retry-After`, and `x-ratelimit-reset`; do not shorten the configured interval in response to a delay.

GitHub's current primary rate limit for a GitHub App installation is at least 5,000 REST requests per hour. Installations on GitHub Enterprise Cloud organizations have a 15,000 per hour limit. Other installations scale with repository and organization-user counts above 20, by 50 requests per hour for each additional repository and user, up to 12,500 per hour. This limit applies to the installation's REST API usage, not separately to each installation token; other requests made through the same installation share it. Check response headers for the actual remaining budget and reset time.

At the default interval, two base list requests per minute (issues and comments) are about 120 requests per hour for one repository before pagination, eligible-comment lookups, and feedback writes. At the minimum 15-second interval, those base list requests alone can be about 480 per hour. Conditional 304 responses reduce primary-limit usage, but changed data, extra pages, and other App activity add requests. Keep the default interval unless you have measured a need for faster pickup. Large or busy repositories can use more requests than this simple estimate.

Primary exhaustion returns HTTP 403 or 429 with `x-ratelimit-remaining: 0`; wait until `x-ratelimit-reset`. A secondary limit can also return 403 or 429. Honor `Retry-After` when present; otherwise wait at least one minute, then back off further if errors continue. The poller preserves its cursor while backing off, so it can resume after the rate window without treating a failed scan as complete. GitHub warns that continuing requests while limited can result in an integration ban.

## Official GitHub references

- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) — prefer webhooks, poll on a fixed schedule, use authenticated conditional requests, and honor poll/rate-limit guidance.
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) — installation limits, rate-limit headers, and primary and secondary limit behavior.
- [GitHub App repository permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) — configure the Issues permission required by the service.
