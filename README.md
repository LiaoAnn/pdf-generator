# pdf-generator

A platform that mass-produces PDF fixtures (realistic documents filled with fake
but valid Taiwanese data) together with a ground-truth file describing every
block on every page, for testing and fine-tuning OCR and document-layout models.
`AGENTS.md` describes the project and how work is organized; `docs/tickets.md`
holds the tickets.

## Layout

A pnpm monorepo of TypeScript-source packages (no build step), running on
Cloudflare Workers.

| Path | Package |
| --- | --- |
| `apps/web` | Website Worker (TanStack Start), `wrangler dev` on port 8787 |
| `apps/print` | PDF print Worker (Browser Rendering, Paged.js), port 8788 |
| `packages/contract` | Shared contract: zod schemas and exported JSON Schema |
| `packages/fake-data` | Seeded fake-data engine |
| `packages/template-tools` | Handlebars fill and template-pack checks |
| `packages/ground-truth` | Ground truth (`gt.json`) from a printed page |

Tooling: TypeScript 7, Vitest 4 (one project per package), Biome, Knip, and
GitHub Actions CI (`.github/workflows/ci.yml`).

## Development

1. Open the repository in VS Code and select **Reopen in Container**. Docker and
   the Dev Containers extension are required. Each checkout (or git worktree)
   gets its own compose project; the compose file publishes no host ports.
2. The post-create script installs `socat`, configures the shared pnpm store, and
   installs Playwright's headless Chromium.
3. Install dependencies and start the web Worker:

   ```bash
   pnpm install
   pnpm dev
   ```

The web Worker is available at `http://localhost:8787` through the Dev
Container's port forwarding. `pnpm dev:print` starts the print Worker on 8788.

The container uses the published TypeScript/Node image directly. Initialization
lives in `.devcontainer/scripts/post-create.sh`; there is no custom Dockerfile.
After changing container configuration, select **Rebuild Container**.

## Commands

Run from the repository root, inside the container.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the web Worker (`apps/web`) |
| `pnpm dev:print` | Start the print Worker (`apps/print`) |
| `pnpm dev:cron` | Run the local cron scheduler in the foreground (Linux) |
| `pnpm typecheck` | Type-check every package with TypeScript 7 |
| `pnpm test` | Run every package's Vitest tests and the cron script tests |
| `pnpm test:cron` | Test cron scheduling and Worker discovery |
| `pnpm lint` | Check formatting and lint rules |
| `pnpm knip` | Find unused files, exports, and dependencies |
| `pnpm format` | Format files |
| `pnpm check` | Apply formatting and lint fixes |
| `pnpm verify` | Everything CI runs: typecheck, lint, knip, test |
| `pnpm cf-typegen` | Regenerate Worker types after changing bindings |

To deploy a Worker, run `pnpm --filter @pdf-generator/<app> run deploy`. For
Cloudflare authentication inside the container, run `bash wrangler_login.sh`.
It uses `socat` to forward the local OAuth callback between IPv4 and IPv6.

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
scheduler. The Workers have no cron triggers yet, so no scheduled requests are
sent until you add them.
