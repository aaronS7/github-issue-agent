# Getting started

## Prerequisites

Use Node 24 or newer, Git 2.36 or newer, and a Linux or macOS host. Run the following commands from the directory containing this project's `package.json`; the example deployment path is `/opt/github-issue-agent`. An HTTPS URL reachable by GitHub is needed in webhook mode; poll mode needs only outbound GitHub API access. Keep `DATA_DIR` on persistent local storage.

## Run the offline demonstration

```sh
npm ci
npm run build
npm run demo
```

The demo uses real SQLite, Git, and just-bash with a scripted model and local GitHub fixture. It sends a signed issue twice, proves delivery deduplication, edits a file, saves a commit/patch, posts feedback to the fixture, and processes a follow-up comment. Its printed paths let you inspect the retained artifacts. It does not contact GitHub or a model provider.

To also generate a recording and inspect it in the local console, run:

```sh
npm run demo:recording
```

The offline demo verifies that it saved an asciicast v2 file and prints a command to launch the console against its temporary data directory, along with the Runs page URL. See [Run observability and terminal replay](observability.md) for replay, exports, and storage details.

For implementation verification:

```sh
npm run check
npm test
```

## Configure a live instance

```sh
cp .env.example .env
chmod 600 .env
```

Edit these settings. Values below are placeholders, not usable credentials:

```dotenv
GITHUB_REPOSITORY=your-owner/your-repository
GITHUB_EVENT_SOURCE=webhook
GITHUB_POLL_INTERVAL_MS=60000
GITHUB_WEBHOOK_SECRET=the-secret-entered-in-your-github-app
GITHUB_APP_CLIENT_ID=your-app-client-id
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/private/path/issue-agent.pem
# Optional; omit to discover the installation for GITHUB_REPOSITORY
# GITHUB_APP_INSTALLATION_ID=12345678
BASE_REF=main
MODEL_PROVIDER=anthropic
MODEL=your-provider-model-id
MODEL_API_KEY=your-model-api-key
DATA_DIR=/var/lib/github-issue-agent
HOST=127.0.0.1
PORT=3000
CONCURRENCY=2
COMMENT_PREFIX=/agent
GITHUB_FEEDBACK=true
```

Choose the repository's actual base branch. Omit `REPOSITORY_PATH` to let the host clone GitHub. If you prefer an existing clone, set its absolute path; only committed history is copied.

The App settings above enable automatic token minting and refresh. In the default webhook mode, configure the App permissions and webhook by following [GitHub App setup](github-app.md). Alternatively, omit both App settings and set a fine-grained personal token in `GITHUB_TOKEN`, restricted to the configured repository with Contents read and Issues read/write; then configure a repository webhook with the same URL, secret, and events. Use the App webhook when following the App guide; no additional repository webhook is needed.

To use polling instead, set `GITHUB_EVENT_SOURCE=poll`, keep the default `GITHUB_POLL_INTERVAL_MS=60000`, and disable webhook delivery in the GitHub App. The service requires a GitHub App or token with Issues read access even when `GITHUB_FEEDBACK=false`; Issues write is needed only when feedback is enabled. Poll mode does not need `GITHUB_WEBHOOK_SECRET`, a webhook subscription, Cloudflare relay, HTTPS reverse proxy, or public inbound port. Follow [Poll GitHub without webhooks](github-polling.md) for first-activation and rate-limit behavior.

The other model option is `MODEL_PROVIDER=openai-compatible`, with `MODEL_BASE_URL` pointing at your provider's chat-completions API base and `MODEL` naming an available model. The GitHub token and the model key are different credentials.

The service reads environment settings at startup. `npm start` and `npm run dev` load `.env`; existing shell environment values take precedence. Set both App variables or neither: an incomplete App configuration is rejected. When both are set, App authentication takes precedence over a static `GITHUB_TOKEN`.

## Start the service

Ensure the service account can write to `DATA_DIR`, then start:

```sh
npm start
```

`npm start` runs the previously built `dist/cli.js`. Rebuild after code updates. For local development, `npm run dev` runs TypeScript directly.

In another terminal:

```sh
curl --fail http://127.0.0.1:3000/healthz
```

In webhook mode, expect `{"ok":true}`. Configure your HTTPS reverse proxy to forward requests without changing the request body. For example, an existing Caddy installation can use its [reverse_proxy directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy):

```caddyfile
agent.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Replace the hostname and configure DNS/TLS for your environment. The GitHub webhook URL is `https://agent.example.com/webhooks/github`. A loopback address or an ordinary private-only URL is not reachable by GitHub.com. In poll mode there is no HTTP listener, so skip the health request and proxy setup. The included systemd example is covered in [operations](operations.md).

## Confirm the first live run

1. Open a small, well-scoped issue in the installed repository, for example: “Correct the addition function and explain what changed.” In poll mode, use an issue updated after the poller's first-activation cutoff.
2. In webhook mode, check the App's Recent deliveries for a successful delivery. Accepted jobs return HTTP 202 with a `jobId`; an ignored event returns 202 with `ignored:true`. Poll mode has no webhook delivery; wait for the next poll interval.
3. Run `node --env-file-if-exists=.env dist/cli.js status` from this project directory. Watch the job move through `queued`, `running`, and `done`.
4. Expect an eyes reaction when work starts, followed by a completion comment and rocket reaction after success. Feedback may arrive later than job completion because it uses its own queue.
5. Inspect the local commit and patch reported by `status`. Then add `/agent add a short usage example` to test a follow-up.

The model receives the event's issue/comment text and previous result summary. It does not automatically receive all historical comments. There is no host test runner by default; see [extensions](extensions.md) for adding capabilities.
