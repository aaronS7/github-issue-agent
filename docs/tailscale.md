# Reach the local console over Tailscale

The setup console can stay bound to loopback while Tailscale Serve gives trusted tailnet devices an HTTPS URL. Serve terminates HTTPS and proxies requests to the local console. The console still handles its own CSRF checks and secret masking, and accepts only the explicitly configured external HTTPS origin.

Tailscale Serve is private to your tailnet. Tailnet access controls determine which devices and users can connect. This console edits an environment file and can read local run history, so keep access limited to trusted operators. Do not use Tailscale Funnel for this administration interface.

## Start the console

Install Tailscale on the host and the devices that need access, and make sure they are connected to the same tailnet. Enable MagicDNS and HTTPS certificates for the tailnet if they are not already enabled. Tailscale Serve provisions the HTTPS certificate and serves a tailnet DNS name.

Build the UI, then start it with the exact HTTPS origin that Tailscale Serve will use. Replace the example hostname with the host's MagicDNS name and select the environment file the console should edit:

```sh
npm run build
npm run ui -- --port 3100 --env-file /absolute/path/to/project.env --public-url https://NODE.TAILNET.ts.net:8443
```

The `--public-url` value must be an HTTPS origin with the exact hostname and port. It must not contain a path, query, or fragment. The server keeps listening on `127.0.0.1:3100`; the public URL tells it which external `Host` and `Origin` values to accept. `UI_PUBLIC_URL` can supply the same value when using environment configuration.

Open a second terminal on the host and start Tailscale Serve:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3100
tailscale serve status
```

Open the `https://NODE.TAILNET.ts.net:8443/` URL on a device in the tailnet. The first command persists this Serve configuration in the background and it resumes after reboot. Tailscale's current reference explains the [`tailscale serve` command](https://tailscale.com/docs/reference/tailscale-cli/serve); its overview distinguishes [private Tailscale Serve from public Funnel](https://tailscale.com/docs/features/tailscale-funnel/how-to/host-websites).

For a built installation without npm, run the compiled console directly. The `--` after `node` is required so the console arguments go to `control-cli.js`:

```sh
node -- dist/control-cli.js --port 3100 --env-file /absolute/path/to/project.env --public-url https://NODE.TAILNET.ts.net:8443
```

## Run it as a user service

The project includes `examples/issue-agent-ui.service` as a systemd user unit. Build the project first, copy the template into your user unit directory, and edit its project directory, Node 24 executable path, and `--public-url` to match your host. Add `--env-file /absolute/path/to/project.env` to `ExecStart` if you want the console to edit an environment file other than `.env` in the project directory.

```sh
mkdir -p ~/.config/systemd/user
cp examples/issue-agent-ui.service ~/.config/systemd/user/github-issue-ui.service
```

After editing the unit, start and inspect it with:

```sh
systemctl --user daemon-reload
systemctl --user enable --now github-issue-ui.service
systemctl --user status github-issue-ui.service
journalctl --user -u github-issue-ui.service -f
```

To have the user service start at boot and continue after logout, enable lingering for that account as an administrator:

```sh
sudo loginctl enable-linger USERNAME
```

The systemd user unit manages the console process. `tailscale serve --bg` separately manages the tailnet proxy and persists its route across reboots. Stop just this HTTPS endpoint with:

```sh
tailscale serve --https=8443 off
```

This removes the Serve configuration for HTTPS port 8443 and leaves configuration on other ports untouched. If you share port 8443 with other Serve paths, include the matching `--set-path` when removing one path. Avoid `tailscale serve reset` when you only intend to remove this console route, since reset clears all Serve configuration on the device.

## Security and operations

The console's remote origin is allowlisted explicitly; it does not trust forwarded host or protocol headers. Keep `--public-url` synchronized with the hostname and port clients use. A host or origin mismatch returns HTTP 403. If the route stops responding, check the user service with `systemctl --user status`, inspect `tailscale serve status`, and confirm that the console is listening on loopback port 3100.

The environment file is separate from the worker process environment. The console saves edits to the selected file; it does not start or restart the issue worker. Set the GitHub and model settings the worker needs, then restart that worker to apply them. Keep the environment file and user service files protected.

The Tailscale URL is private to the tailnet and is not reachable by GitHub.com. This serves the configuration console only; it does not expose the issue webhook. If GitHub webhooks need to reach the worker, configure a separate public HTTPS endpoint or a trusted relay for the webhook receiver. Keep that receiver's signature checks and webhook secret in place.

[Back to documentation index](start-here.md)
