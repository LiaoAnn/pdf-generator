# Cloudflare Workers Project Base

A minimal, framework-neutral reference for starting TypeScript projects on
Cloudflare Workers. Use this repository's tooling and development environment as
a starting point for an agent to initialize a Hono HTTP server or a TanStack Start
web application.

## Included

- A native Worker entry point in `src/index.ts` that returns `Hello, World!`.
- Wrangler configuration for local development, deployment, and binding types.
- Biome for linting and formatting.
- Knip for finding unused files, exports, and dependencies.
- A Node.js 24 Dev Container with pnpm and a persistent package store.

No application framework is installed. Add the framework, dependencies, and
configuration that the new project needs.

## Development

1. Open the repository in VS Code and select **Reopen in Container**. Docker and
   the Dev Containers extension are required.
2. The post-create script installs `socat` and configures the pnpm store. Compose
   creates the store volume automatically; no host store setup is needed.
3. Set the project name in `package.json` and `wrangler.jsonc`.
4. Install dependencies and start the Worker:

   ```bash
   pnpm install
   pnpm dev
   ```

The Worker is available at `http://localhost:8787`.

The container uses the published TypeScript/Node image directly. Initialization
lives in `.devcontainer/scripts/post-create.sh`; there is no custom Dockerfile.
After changing container configuration, select **Rebuild Container**.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the local Worker |
| `pnpm dev:cron` | Run the local cron scheduler in the foreground (Linux) |
| `pnpm test:cron` | Test cron scheduling and Worker discovery |
| `pnpm lint` | Check source formatting and lint rules |
| `pnpm knip` | Find unused files, exports, and dependencies |
| `pnpm format` | Format source files |
| `pnpm check` | Apply source formatting and lint fixes |
| `pnpm cf-typegen` | Regenerate Worker types after changing bindings |
| `pnpm deploy` | Deploy the Worker to Cloudflare |

For Cloudflare authentication inside the container, run `bash wrangler_login.sh`.
It uses `socat` to forward the local OAuth callback between IPv4 and IPv6.

## Starting a framework project

Ask your agent to use this repository as a tooling reference and initialize the
chosen framework for Cloudflare Workers:

- **Hono:** install Hono and replace the native Worker entry point with the HTTP
  application. Add routes and bindings as needed.
- **TanStack Start:** initialize the framework's Cloudflare setup and adapt its
  entry points, scripts, TypeScript, and Wrangler configuration. Keep the Biome and
  Dev Container setup as the shared baseline.

This repository's `src/index.ts` and Wrangler scripts are a minimal Worker example;
framework projects should use their own required development and build setup.

## Local cron triggers

The Dev Container starts a local cron scheduler through `postStartCommand`.
Rebuild the container once after adopting this configuration, or run
`bash .devcontainer/scripts/cron.sh --background` in the existing container.
It waits for `pnpm install` to finish before starting. A workspace lock prevents
duplicate schedulers, including when running `pnpm dev:cron` manually.

Start your Worker or Vite application normally. The scheduler discovers
`wrangler.jsonc` files recursively within the workspace and reads their
`triggers.crons`. It skips hidden directories, `node_modules`, `dist`, `build`,
`coverage`, and symbolic links. Configuration and running servers are checked
approximately every five seconds.

Destination selection, in order:

1. An explicit `url` in `.devcontainer/cron-targets.jsonc`.
2. A running Vite or local Wrangler dev server associated with the config. On
   Linux, the scheduler matches process working directories and `--config` paths,
   then reads the sockets owned by those processes. Wrangler's child `workerd`
   processes are included because they can own the public HTTP socket.

Vite servers are identified through `/@vite/client`. Wrangler servers are
identified through the read-only `/cdn-cgi/local/explorer/api/local/workers` API,
including a check of the local Worker's name when configured. Inspector and
internal runtime sockets are distinguished from the public server. Discovery
never invokes a scheduled handler as a port probe.

For example, `vite dev --port 3000 --host` uses the actual Vite port even when
`vite.config.ts` has no port. Wrangler CLI port overrides, OS-assigned ports, and
port changes after restarts are also discovered. If a server automatically picks
another port, its actual socket is used. Some versions fail on a port conflict
instead; an app that failed to start is not scheduled. An occupied port alone
does not establish which Worker owns it.

When no matching dev server is running, the scheduler waits for the next scan.
It never falls back to `server.port`, `dev.port`, 5173, or 8787. Explicit URLs are
the escape hatch for servers that cannot be discovered automatically.

Vite configuration is located alongside the Worker config or in a parent
directory up to the nearest package boundary. Imported config dependencies and
development `.env` files are watched by modification time. Vite configuration is
only evaluated when a running server needs its custom base path or HTTPS setting;
its configured port is never used as a destination. Use explicit URLs for custom
server wrappers, other Vite modes, older Wrangler versions without the Local
Explorer API, or ambiguous multi-server setups.

Example `.devcontainer/cron-targets.jsonc`:

```jsonc
{
  "workers": {
    "apps/api/wrangler.jsonc": { "url": "http://127.0.0.1:8788" },
    "apps/web/wrangler.jsonc": { "url": "http://localhost:3000" },
    "apps/jobs/wrangler.jsonc": { "environment": "development" },
    "apps/disabled/wrangler.jsonc": { "enabled": false }
  }
}
```

Keys are workspace-relative paths. `environment` selects that environment's
triggers, inheriting the top-level triggers when not overridden, just as Wrangler
does. Running Wrangler's `--env` is detected automatically; an explicitly selected
environment must match it. For Vite or an explicit URL, select the environment
that the application is running with. URLs must be local origins:
loopback addresses or `host.docker.internal`. Workers sharing an origin are skipped
with a diagnostic until their destinations are made distinct.

At each matching UTC minute, the scheduler sends a GET request to
`/cdn-cgi/local/scheduled` with the original `cron` and the scheduled `time` in
milliseconds. This is the local endpoint supported by
[Wrangler and the Cloudflare Vite plugin](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally).
The application must export a scheduled handler (or expose a Worker with one).
The scheduler does not start application servers.

Five-field schedules use Cloudflare's weekday numbering (1 = Sunday, 7 = Saturday)
and support `L`, `W`, and `#` calendar modifiers. Invalid or unsupported expressions
are reported with their config path. The first eligible run is the next minute
after scheduler startup. Missed runs are not replayed, failed requests are not
retried, and each request has a ten-second timeout.

Read the background log with `tail -f .wrangler/cron.log`. To pause an individual
Worker, set `enabled: false` in the targets file; stopping the container stops the
scheduler. The repository's base Worker has no cron triggers, so no scheduled
requests are sent until you add them.
