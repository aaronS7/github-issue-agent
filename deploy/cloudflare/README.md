# Cloudflare relay handoff

This package deploys the optional GitHub webhook relay described in [the deployment guide](../../docs/cloudflare-relay.md). It is intended to be operated with the repository's pinned Wrangler dependency, not a globally installed CLI.

From the repository root:

```sh
npm --prefix deploy/cloudflare ci
npm --prefix deploy/cloudflare run check
npm --prefix deploy/cloudflare run test
npm --prefix deploy/cloudflare run dev
npm --prefix deploy/cloudflare run dry-run
npm --prefix deploy/cloudflare run deploy
```

`check`, `test`, and `dev` are local actions. `dry-run` only bundles and checks; `deploy` publishes to the Cloudflare account selected by Wrangler and makes the Worker live. Authenticate with `npm --prefix deploy/cloudflare exec -- wrangler login --cwd deploy/cloudflare` before resource setup or deployment. Review [the deployment guide](../../docs/cloudflare-relay.md) for resource creation, secrets, local host configuration, verification, and recovery.

## Handoff prompt for another coding agent

> Deploy this repository's optional Cloudflare GitHub webhook relay by following `docs/cloudflare-relay.md` and `deploy/cloudflare/README.md`. First inspect the pinned Wrangler package, `wrangler.jsonc`, scripts, and Worker behavior; then inspect the logged-in Cloudflare account for existing resources before creating anything. Confirm `GITHUB_REPOSITORY` and all resource names against the target repository. Preserve private R2 storage, the primary Queue HTTP pull consumer and DLQ, 30-day R2 expiration, and the required secrets. Run the local check/test scripts and Wrangler dry-run; verify the target account and configured Worker name before deploying, then report every command/result, secrets entered by name (never their values), queue ID, deployed relay URL, and checks still to be done on the private host/GitHub. Do not claim a real GitHub delivery or end-to-end host test unless it was actually performed.
