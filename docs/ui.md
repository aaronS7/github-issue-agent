# Local setup console

The setup console gives a local operator a form for editing the service's `.env` file and checking the values before starting the worker. It listens on loopback by default and is intended for setup on the same machine as the service. It is not a public administration server or a way to change operating-system permissions.

To open the console from another device in your tailnet, keep the listener on loopback and proxy it with Tailscale Serve using an explicitly configured HTTPS origin. See [Reach the local console over Tailscale](tailscale.md) for interactive and systemd user-service commands.

## Start the console

Build the project and start the console with:

```sh
npm run ui
```

The console listens on `127.0.0.1:3100`. To edit another environment file or use another port, pass options after `--`:

```sh
npm run ui -- --env-file /etc/github-issue-agent.env --port 3101
```

For frontend development, run the API and Vite server in separate terminals:

```sh
npm run ui:api
npm run ui:dev
```

The API listens on port `3100`; Vite serves the page on port `5173` and proxies console requests to the API. `npm run build` builds the worker and console, and `npm run check` includes the frontend type check.

Run the browser checks with `npx playwright install --with-deps chromium` followed by `npm run test:ui`. They exercise the built UI with a temporary environment file, local repository, and offline issue worker fixture using a scripted model and local GitHub fixture. The checks make no external GitHub or model requests.

## Configure and check

The console groups configuration into GitHub, Triggers, Model & runtime, Tools, and Observability. Drafts may be incomplete while you work. Save writes the edited values to the selected environment file; it does not apply them to an already running worker. Restart the service after saving. The separate **Runs** view reads the saved `DATA_DIR` and refreshes queue and timeline details every two seconds while visible.

GitHub settings cover one repository, its base ref, event source, GitHub App credentials or a static token, optional local repository path, and optional GitHub Enterprise URLs. Choose **GitHub webhooks** (the default) or **Poll the GitHub API**. Polling lets the service find issues without inbound webhooks; it requires Issues read access even if feedback is disabled. The poll interval defaults to 60 seconds and accepts 15 seconds to 1 hour. Poll mode does not start the webhook listener and does not require a webhook secret, public endpoint, or Cloudflare relay. Restart the service after saving to activate the chosen mode. See [Poll GitHub without webhooks](github-polling.md) for trigger behavior, first-activation cutoff, and GitHub rate limits.

In webhook mode, the page shows the webhook secret, endpoint, and optional Cloudflare relay settings. The relay is a webhook transport and is not used by polling. A GitHub App client ID and private key path must be set together. The installation ID can be omitted for discovery. App credentials take precedence over a static token. GitHub feedback is enabled by default and requires Issues write access for outgoing GitHub actions.

The webhook section also has optional Cloudflare relay settings: Worker origin, account and queue IDs, masked Cloudflare API and relay tokens, and relay polling interval. Deploy the [Cloudflare template](cloudflare-relay.md) first, then enter the resulting settings. The webhook endpoint preview uses the configured Worker origin. Check configuration validates local field syntax and completeness; it does not contact Cloudflare. Restart the issue service after saving to activate relay ingestion. Clear the relay URL, queue ID, and relay token to disable it; account credentials alone do not activate the relay.

Trigger settings control issue actions, required labels, allowed issue authors, ignored bot logins, and the prefix required on follow-up comments. Every configured label must be present. The author allowlist applies to the issue author for both initial issue events and follow-up comments. The default prefix is `/agent`; an empty prefix accepts any non-bot comment. Bot-authored issues can qualify, while bot comments and comments containing the agent marker are ignored.

The model choices are Anthropic and OpenAI-compatible chat-completions providers. Set a provider model ID. Anthropic requires an API key; OpenAI-compatible providers accept an optional API key and require an API base URL. Anthropic can use a custom base URL if needed. Runtime bounds include concurrency, lease duration, attempts, bash steps, and run timeout. The agent's task prompt is assembled by the worker from the issue snapshot and fixed safety instructions; there is no prompt editor.

The Tools settings point to an optional trusted JavaScript extension module. Extensions can add just-bash commands, lifecycle hooks, or a model adapter. They run in the service process, so only configure code you trust. **Check configuration** does not load or execute the module. If model settings are omitted, it warns that the extension must export `createModel`; otherwise the worker needs the normal model settings. The model's built-in tool is bash inside the isolated issue workspace; arbitrary host shell commands, network access, and package managers are unavailable by default. Successful work is saved as local Git artifacts; the service does not push a branch or open a pull request.

The Observability settings control optional asciinema `.cast` files. The attempt event timeline is always recorded. Terminal recording defaults off; enabling it writes local files for new attempts after the worker restarts. Cast files contain scripts and completed output chunks, not keystrokes or live terminal output. The Runs player has play, pause, seeking, and 0.5×, 1×, 1.5×, and 2× speed controls. It uses snapshots while an attempt runs, with an explicit refresh for newer output and one automatic final snapshot after the attempt ends. See [Run observability and terminal replay](observability.md) for limits, exports, redaction, and retention.

Use **Check configuration** to validate required values and configuration relationships. It does not call a model, load an extension, or send a webhook. Use **Test connection** only when you want a live GitHub check: it may discover the App installation, mint an installation token, and request the configured repository. It does not verify webhook delivery or post a comment. The local private key path stays on the machine and the key is never uploaded by the console.

## Secrets and concurrent edits

Stored secrets are masked. The console reports whether a secret is present without returning its value to the browser. Enter a replacement to rotate a secret, or use the explicit remove action to delete it. An empty password field leaves the stored secret unchanged.

Saving uses an atomic replacement of the environment file. If another process or operator changes that file after the console loads it, the save is rejected with a conflict; reload the latest configuration before applying your edits. Keep the environment file and its directory protected as you would any service credential file.

The console offers a masked, read-only preview to help review the configuration draft. Values are displayed in a JSON-quoted representation, so the preview is not an exact `.env` file and should not be deployed. It cannot establish that the model is available, that GitHub permissions cover every operation, or that an externally configured webhook can reach the worker. Verify those integrations with the appropriate live check or a real test delivery.

## Frontend structure

The page and save flow live in `ui/src/App.tsx`; `ui/src/pages/` contains the GitHub, trigger, runtime, tools, setup, observability, and runs pages. Reusable field controls are in `ui/src/components/fields.tsx`, while buttons, badges, sections, notices, and dialogs are in `ui/src/components/primitives.tsx`. Run replay and timeline components are separate from the configuration form. Shared color, type, and surface variables live in `ui/src/styles/tokens.css`, with control and layout rules in `components.css` and `layout.css`.
