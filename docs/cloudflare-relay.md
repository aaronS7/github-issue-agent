# Cloudflare webhook relay deployment

This guide deploys the optional public GitHub webhook ingress used by the local issue agent. Cloudflare validates GitHub's signature, stores the exact raw request body (up to 1 MiB) in a private R2 bucket, then queues only a pointer. The agent on the Tailscale host pulls queue messages over HTTPS and fetches the raw body from the authenticated Worker endpoint. The host needs no inbound public connection; keep the UI private on Tailscale.

The relay accepts one repository, set as `GITHUB_REPOSITORY=owner/repo`. Keep `GITHUB_WEBHOOK_SECRET` identical in GitHub, Cloudflare, and the local host. `RELAY_AUTH_TOKEN` protects payload retrieval; generate a separate random token of at least 32 characters with no whitespace. The local host needs `CLOUDFLARE_RELAY_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_QUEUE_ID`, `CLOUDFLARE_API_TOKEN` (Queues Read and Queues Write), and `CLOUDFLARE_RELAY_TOKEN`; `CLOUDFLARE_POLL_INTERVAL_MS` is optional (default 5000). Do not put these credentials in Git, issue comments, chat, or logs.

## Deploy

Run these commands from the repository root. The package is self-contained under `deploy/cloudflare`; its README has the local check and development commands. First install its pinned dependencies and inspect the deployed account:

```sh
npm --prefix deploy/cloudflare ci
npm --prefix deploy/cloudflare exec -- wrangler login --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler queues list --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler r2 bucket list --cwd deploy/cloudflare
```

Confirm the intended account in the Wrangler login output/dashboard. Before creating anything, check whether the default resources already exist and whether names refer to this project: `github-issue-webhooks`, `github-issue-webhooks-dlq`, and `github-issue-webhook-payloads`. Reuse only verified resources. Do not delete or recreate resources just to resolve a name collision; choose new names in `deploy/cloudflare/wrangler.jsonc` and create those instead. Set `GITHUB_REPOSITORY` and any changed resource names in that config before deployment.

Create only the resources that are missing:

```sh
npm --prefix deploy/cloudflare exec -- wrangler queues create github-issue-webhooks --message-retention-period-secs 86400 --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler queues create github-issue-webhooks-dlq --message-retention-period-secs 86400 --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler r2 bucket create github-issue-webhook-payloads --cwd deploy/cloudflare
```

The example creates both queues with one day of retention, the Free plan maximum; on a paid plan you may configure either queue up to 1,209,600 seconds (14 days). Use the configured retention as a recovery deadline, including for the DLQ; monitor and replay failures before that deadline. Queues are unordered and deliver at least once, so local processing can deduplicate durable deliveries and process in local arrival order, but cannot promise GitHub's original event chronology. Acknowledge a message only after its SQLite transaction commits. Configure the primary queue for HTTP pull and attach the DLQ; Cloudflare's Wrangler CLI supports:

```sh
npm --prefix deploy/cloudflare exec -- wrangler queues consumer http list github-issue-webhooks --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler queues consumer http add github-issue-webhooks --message-retries 5 --visibility-timeout-secs 600 --dead-letter-queue github-issue-webhooks-dlq --cwd deploy/cloudflare
```

If an HTTP consumer already exists, inspect its settings and do not add a second one. Cloudflare requires an account API token with both Queues Read and Queues Write permissions for the local puller; pull and acknowledgement both mutate/read queue state. Save the queue ID shown in Cloudflare for `CLOUDFLARE_QUEUE_ID` on the local host. The DLQ holds messages that exhaust retries; monitor it and replay deliberately after fixing the cause. This template requests a ten-minute visibility lease for each batch. A failed or interrupted message becomes eligible for redelivery after the lease expires.

Add a lifecycle rule to expire payload objects after 30 days. This exceeds the maximum Queue message retention and allows time to inspect/recover DLQ deliveries. Never delete an R2 object as part of per-message acknowledgement: retries, redelivery, and DLQ recovery still need the payload.

```sh
npm --prefix deploy/cloudflare exec -- wrangler r2 bucket lifecycle list github-issue-webhook-payloads --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler r2 bucket lifecycle add github-issue-webhook-payloads --id github-issue-payload-retention-30d --expire-days 30 --cwd deploy/cloudflare
```

If a lifecycle rule already exists, verify its prefix and age before changing it. R2 applies lifecycle expiration asynchronously; objects are typically removed within 24 hours after expiry. The bucket must remain private: do not enable public access or create a public custom domain.

Review the Worker bundle and deploy it once to create the Worker. Do not configure GitHub to send deliveries yet:

```sh
npm --prefix deploy/cloudflare run dry-run
npm --prefix deploy/cloudflare run deploy
```

`dry-run` compiles without deploying. `deploy` publishes the Worker and makes its URL live. `wrangler secret put` immediately creates and deploys a new Worker version, so set both Worker secrets after that initial deployment and before connecting the GitHub webhook. Wrangler prompts for each value. Use the same GitHub webhook secret that you will configure in GitHub, and generate a separate long random relay token for `RELAY_AUTH_TOKEN`:

```sh
npm --prefix deploy/cloudflare exec -- wrangler secret put GITHUB_WEBHOOK_SECRET --cwd deploy/cloudflare
npm --prefix deploy/cloudflare exec -- wrangler secret put RELAY_AUTH_TOKEN --cwd deploy/cloudflare
```

Secrets are encrypted and not readable back from Wrangler. Keep production values in a password manager. For local Worker development, put test values in an ignored `.dev.vars` file inside `deploy/cloudflare`; never commit it. The host's `.env` is separate and should be protected with restrictive file permissions. For subsequent code changes, review the Worker bundle with `npm --prefix deploy/cloudflare run dry-run` then publish with `npm --prefix deploy/cloudflare run deploy`. Only configure the GitHub webhook after secrets have been entered. This guide does not claim that any Cloudflare resource or Worker has been deployed or tested against a real account.

## Connect and verify

Copy the deployed `workers.dev` URL to the local host as `CLOUDFLARE_RELAY_URL` (for example, `https://<worker-name>.<account-subdomain>.workers.dev`). On the host, configure the six Cloudflare settings in the GitHub tab (or in the service environment file): relay URL, account ID, queue ID, Queues Read/Write API token, relay token, and optional poll interval. The first five values are required together; the interval defaults to 5000 ms. The UI masks credentials after saving. Protect the host's environment/config file with restrictive permissions. The runtime reads these values at startup, so restart the issue-agent service after saving them (for example, `sudo systemctl restart issue-agent`).

In the GitHub App's webhook settings (preferred; a repository webhook also works), set the target to `<WorkerURL>/webhooks/github`, enter the matching webhook secret, subscribe to Issues (`issues`) and Issue comments (`issue_comment`), and enable SSL verification. Send GitHub's signed ping first and confirm the Worker responds with HTTP 200; ping deliveries do not create queue messages. Then create a controlled test issue, verify queue activity, and confirm it reaches the local agent despite possible queue redelivery. Worker request logs are disabled by default and payload bodies are never logged. Confirm an invalid signature is rejected, temporarily stop the host to observe messages wait in the queue, and confirm recovery after it resumes. If deliberately exercising retries, use a test delivery and verify exhausted messages appear in the DLQ; do not use a production issue as a failure probe.

The normal local startup (`npm start`) runs the existing workers, loopback receiver, and the optional Cloudflare pull loop when relay settings are configured. To disable relay polling, clear the relay URL, queue ID, and relay token. An account ID or API token alone does not activate the relay. Keep the UI access restricted to Tailscale; the only public HTTP surface here is the Worker ingress and its bearer-authenticated payload route.

## Operations and cleanup

Check daily that the Worker is healthy, the primary queue is draining, the DLQ is empty or has an investigated reason, the R2 lifecycle rule remains enabled at 30 days, and webhook deliveries are succeeding. Alert on repeated Worker errors, queue age/backlog, any DLQ messages, or failed delivery processing. During outages, remember that Free queue retention is only 24 hours; on paid plans it can be configured up to 14 days. R2 payloads remain for 30 days, but a message that expires from the queue no longer has an automatic path back to the local agent.

To retire the relay, first disable/delete the GitHub webhook and stop the local puller. Inspect and preserve any primary or DLQ messages and payloads needed for recovery. Then remove the Worker and queue consumer configuration using Wrangler, and delete queues/bucket only after confirming their contents are no longer needed. Queue and bucket deletion is destructive; deleting the bucket permanently removes retained raw webhook bodies. Removing a lifecycle rule does not delete stored objects, while leaving it enabled continues expiration of matching objects.

## Official Cloudflare references

- [Queues Wrangler commands](https://developers.cloudflare.com/queues/reference/wrangler-commands/) — queue creation, retention, and consumer commands.
- [HTTP pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/) — pull authentication, acknowledgement, and required API token permissions.
- [Retries and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) and [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) — retry behavior and DLQ retention.
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) — Free and paid retention limits.
- [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) — lifecycle commands and expiration timing.
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/) — secret management and dry-run/deploy behavior.
