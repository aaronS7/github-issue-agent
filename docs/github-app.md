# Set up a GitHub App

The service can receive a GitHub App's webhooks or poll GitHub's REST API, and use its private key to mint and refresh installation tokens automatically for Git and REST calls. Polling is useful when the host cannot receive inbound webhooks. The standalone minting helper remains available for optional manual debugging and legacy static-token setups.

## 1. Register the App

In the owning account or organization, open **Settings → Developer settings → GitHub Apps → New GitHub App**. Use a unique name and a homepage URL you control. For this installation-only service, leave OAuth/user-authorization and device-flow options off; it has no OAuth callback or setup handler. GitHub's [registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) describes those fields.

For webhook mode (the default), configure the App's webhook:

| Field | Value |
| --- | --- |
| Active | Enabled. |
| Webhook URL | `https://agent.example.com/webhooks/github`, using your reachable HTTPS host. |
| Webhook secret | A random secret, also saved as `GITHUB_WEBHOOK_SECRET`. |
| SSL verification | Enabled. |
| Installation scope | Only your account for a private personal setup; choose the accounts appropriate to your deployment. |

You can generate a webhook secret locally with:

```sh
openssl rand -hex 32
```

Store the value in the App settings and service configuration. It authenticates inbound webhook payloads; it is separate from the App private key and installation token.

For poll mode, disable App webhook delivery. Polling needs no webhook URL or secret, public inbound listener, or Cloudflare relay. Set `GITHUB_EVENT_SOURCE=poll` and follow [Poll GitHub without webhooks](github-polling.md). Keep the App private key on the service host.

For the optional [Cloudflare relay](cloudflare-relay.md) in webhook mode, use the deployed Worker URL plus `/webhooks/github` as the App's webhook URL. Store the same webhook secret in the Worker and local service. The relay's accepted response means Cloudflare has persisted the delivery; the local job appears after the service pulls it.

## 2. Grant permissions and subscribe to events

Use these repository permissions for the currently implemented behavior:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read-only | Clone the repository and refresh the source cache. |
| Issues | Read | Required for REST polling. Add write access when feedback is enabled, for posting replies and reactions. |
| Metadata | Read-only | GitHub's standard repository metadata access. |

Subscribe to **Issues** (`issues`) and **Issue comment** (`issue_comment`) only for webhook mode. Poll mode uses REST snapshots and needs no webhook subscriptions. Pull-request events are not used. The current service does not push code or create PRs, so it does not need Contents write or Pull requests write. GitHub documents [permission selection](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [comment creation](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment), and [reaction creation](https://docs.github.com/en/rest/reactions/reactions#create-reaction-for-an-issue).

Create the App. In webhook mode, this App webhook supplies events; do not also add a repository webhook for the same service just to make the App work. In poll mode, leave webhook delivery disabled.

## 3. Install it on the repository

Open the App's **Install App** page, select the account, and install it on the repository named in `GITHUB_REPOSITORY`. Select specific repositories for this single-repository service. Follow GitHub's [installation instructions](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) if organization approval is needed.

Registration and installation are separate steps. Creating an App does not grant it access to a repository. If you change permissions later, accept the installation's updated permissions before minting another token.

## 4. Generate a private key and record the client ID

On the App settings page, record its **Client ID** and generate a private key. Keep the downloaded PEM on the trusted service host, outside the watched codebase and agent checkout. Give the service operator access to it, for example with `chmod 600 /absolute/private/path/issue-agent.pem`. See [managing App keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

There are several distinct values:

| Value | Used for |
| --- | --- |
| Client ID | Identifies the App when signing an App JWT. |
| PEM private key | Signs that JWT on the trusted host. |
| Installation ID | Identifies the App installation for an account. The service and helper discover it from the repository unless explicitly configured. |
| Installation token | Short-lived credential used for Git and REST calls. |
| Webhook secret | Verifies inbound webhook signatures. |

The GitHub OAuth client secret is not used by this service. The service signs App JWTs on the host to request installation tokens.

## 5. Configure automatic authentication

Set the App client ID and path to its private key in the service environment. Keep the key on the trusted host, outside the watched codebase and agent checkout. An installation ID is optional; by default the service finds the installation associated with `GITHUB_REPOSITORY`.

```dotenv
GITHUB_REPOSITORY=your-owner/your-repository
GITHUB_APP_CLIENT_ID=your-app-client-id
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/private/path/issue-agent.pem
# Optional; omit to discover the installation for GITHUB_REPOSITORY
# GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_FEEDBACK=true
```

Set both `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` to enable App authentication. If only one is set, startup rejects the incomplete configuration. When both are set, App authentication takes precedence over `GITHUB_TOKEN`; otherwise `GITHUB_TOKEN` is used as a static-token fallback. The key is read and validated as an RSA key at startup and held by the service process. Restart the service to apply configuration changes or rotate the key.

The provider requests a token scoped to `GITHUB_REPOSITORY` with **Contents: read**. When `GITHUB_FEEDBACK=true`, it also requests **Issues: write**. With feedback disabled, it requests **Issues: read** in poll mode and no Issues permission in webhook mode. Configure the App's repository permissions accordingly, then accept any updated permissions on the installation.

The first GitHub request obtains a token. The process shares one in-memory token provider, and concurrent requests share an in-progress refresh. It refreshes on demand when the cached token is within 60 seconds of expiry. Each REST call and each Git clone or fetch asks the provider for a usable token; it reuses the cached token until refresh is due. A REST 401 or explicit Git authentication rejection causes one refresh and retry. A Git 404, permission denial, or network failure does not trigger an authentication retry; it follows the normal job retry policy. Other REST failures follow the normal queue or outbox retry behavior.

GitHub installation tokens expire after one hour. Expiry is a limit on an individual token; the running service mints a replacement as needed and does not require an hourly restart. It keeps no token on disk and starts no refresh timer while idle. Restart after changing the App credentials or key. See [GitHub's installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## 6. Optional manual token helper

The project includes `examples/mint-installation-token.mjs`, a standalone Node example. Add these helper settings to your local `.env` alongside the service settings:

```dotenv
GITHUB_APP_CLIENT_ID=your-app-client-id
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/private/path/issue-agent.pem
GITHUB_REPOSITORY=your-owner/your-repository
```

Run from this project's directory to print a token into the current shell variable:

```sh
GITHUB_TOKEN="$(node --env-file=.env examples/mint-installation-token.mjs)" || exit 1
export GITHUB_TOKEN
```

The command substitution captures the token into the current shell without displaying it. The helper reports the installation ID and expiration time on stderr. Treat the token as an opaque string; do not depend on a fixed length. This helper is optional when automatic App authentication is configured. It is useful for debugging or for a legacy deployment that uses a static `GITHUB_TOKEN`; that token expires and must be replaced manually. To run the service in static-token mode, omit both `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` from its environment. App settings take precedence, so exporting `GITHUB_TOKEN` does not disable App authentication.

The helper signs an RS256 JWT with the client ID, allows clock skew, finds the repository's installation, and requests a token limited to that repository with `contents:read` and `issues:write`. The account must already have installed the App with those permissions. The underlying protocol is documented in [App JWT generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [installation-token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

The example is included in the codebase; its source is also included at the end of this wiki page for readers without the local checkout. It mints one token on demand and does not manage the service's token cache.

## 7. Check deliveries and a real issue

With the service reachable, open the App's **Advanced → Recent deliveries** and inspect its webhook delivery history. A registration `ping` is acknowledged but creates no job. Open an issue in the installed repository and confirm the `issues` payload returns a `jobId`. See [getting started](getting-started.md) for the complete smoke-check sequence.

The service only accepts its configured `GITHUB_REPOSITORY`, even if the App is installed on other repositories. It uses the configured or discovered installation for that repository; it does not route work across repositories. Use a dedicated configured instance for each repository.

## GitHub Enterprise Server

Set both `GITHUB_SERVER_URL=https://github.example.com` and `GITHUB_API_URL=https://github.example.com/api/v3`. The service uses them for cloning and REST calls. Register and install the App on that same server. Enterprise-specific behavior has not been exercised against a live server.

See [operations and troubleshooting](operations.md) for 401/403/404 errors, queue redrive, and webhook recovery.
