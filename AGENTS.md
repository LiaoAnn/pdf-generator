# pdf-generator

Read this whole file before you change anything. It tells you what the project is for, how work is organized, and what you must not do. You do not need any earlier conversation: everything a ticket needs is in the ticket, this file, and the skills it names.

## What this project is

A platform that mass-produces **PDF fixtures**: realistic documents in a format the user chooses (company monthly report, incident form, financial statement, paper, bank statement, ...) filled with fake but valid Taiwanese data, each delivered with a **ground-truth file** describing exactly what is on every page. They are used to test and fine-tune OCR and document-layout models, so the ground truth must match the printed PDF exactly. A fixture whose ground truth is off by one box is worse than no fixture.

The pipeline, end to end:

1. A **template pack** (HTML + CSS + Handlebars + data rules + sample data) is uploaded to the platform.
2. The **fake-data engine** generates a record from the pack's rules and a **seed** (same seed → same record).
3. The record is filled into the HTML, and **Browser Rendering** prints it to PDF with **Paged.js** pagination and embedded Chinese fonts.
4. From the printed page, the platform reads the **ground truth** (`gt.json`): every element marked with `data-gt`, its block type, text, page, bounding box and reading order.
5. A **self-check** extracts text and positions from the PDF and compares them with `gt.json`.
6. A **batch** repeats this N times (Workflows + Queues), stores results in R2, and offers them as a zip.

Separately, **local projects** run on the user's Mac, not here: they cut a real PDF into blocks with MinerU, de-identify it, and have an agent write a template pack from it (`pdf2tpl`). They talk to the platform only through the exported JSON Schemas and the upload API.

### Glossary

| Term | Meaning |
| --- | --- |
| template pack (樣板包) | A zip with a manifest, HTML/CSS, Handlebars template, data rules and sample data. Its shape is defined by the shared contract. |
| `data-gt` | The HTML attribute that marks an element as a ground-truth block. Unmarked content is a pack error. |
| `gt.json` | Ground truth for one PDF: blocks with type, text, page, box, reading order, plus table/checkbox/formula details. |
| block list (區塊清單) | The unified block format the local MinerU tooling outputs. |
| seed | The input that makes fake data and a whole batch reproducible. |
| batch (批次) | N fixtures from one template version and one seed; re-running it must reproduce it exactly. |
| shared contract (共用契約) | zod schemas for the manifest, rule file, `gt.json`, block list and API types, exported as JSON Schema (ticket T02). |

## Where things are

- `docs/tickets.md`: all tickets (Chinese): goal, Blocked by, Blocks, collision risk, acceptance tests, out of scope, estimated lines. **The source of truth for scope.**
- Ticket status is not stored in the repo. A ticket is running when its T3 thread (`TNN …`) is open, and done when its PR (branch `tNN-…`) has merged.
- `.claude/skills/`: this project's skills (below). General skills (`plan-it`, `implement-plan`, `tdd`, `review-change`, `verification-evidence`, `diagnose-bug`, `drizzle-orm`) are installed globally; the project skills add rules on top of them and win where they differ.
- The platform is a pnpm monorepo. Every workspace package is named `@pdf-generator/<dir>`, is TypeScript source with no build step (`exports` points at `src/index.ts`), and has its own `tsconfig.json` (extending `tsconfig.base.json`), `vitest.config.ts` and tests next to the code (`src/**/*.test.ts`). Until its ticket fills it, a package holds only a placeholder export and test.

| Path | Package | What it is | Filled by |
| --- | --- | --- | --- |
| `packages/contract` | `@pdf-generator/contract` | Shared contract: zod schemas, exported JSON Schema | T02 |
| `packages/fake-data` | `@pdf-generator/fake-data` | Seeded fake-data engine, Taiwanese fields | T05, T12 |
| `packages/template-tools` | `@pdf-generator/template-tools` | Handlebars fill and template-pack checks (platform and local) | T06 |
| `packages/ground-truth` | `@pdf-generator/ground-truth` | Reads `gt.json` blocks from a printed page | T08, T13 |
| `apps/web` | `@pdf-generator/web` | The website Worker (TanStack Start), `wrangler dev` on port 8787 | T09 |
| `apps/print` | `@pdf-generator/print` | The PDF print Worker (Browser Rendering, Paged.js), port 8788 | T07 |
| `packages/dev-tools` | `@pdf-generator/dev-tools` | Dev tools, not part of the product (`pdf-to-png`) | T14-2 |

- Shared tool versions (`typescript`, `vitest`, `wrangler`) live in the `catalog:` of `pnpm-workspace.yaml`; a package lists them as `"catalog:"`. Vitest stays on 4.x so `@cloudflare/vitest-pool-workers` can be added when a Worker needs tests inside workerd.
- Each Worker app has its own `wrangler.jsonc` and generated `worker-configuration.d.ts` (`pnpm cf-typegen`).
- `.devcontainer/`: the per-worktree environment (Dev Container + compose; no host ports). `.github/workflows/ci.yml`: CI runs install, typecheck, lint, knip and test on every PR and on `main`.

## Commands

Run every project command inside your worktree's stack (see "Environment"), never on the VM host. Stopping dev servers: killing the tmux session doesn't stop what `wt-exec` started, and `wrangler dev` leaves `workerd` and Chrome children (GBs of RAM). Stop them with `wt-exec bash -lc "pkill -f '[w]rangler-dist/cli.js'; pkill -f '[v]ite'; pkill -f '[w]orkerd'; pkill -f '[c]hrome-linux64'"` (wrangler first: a surviving wrangler respawns `workerd`, and the next `dev:print` fails with `Address already in use`) (the bracket keeps `pkill` from matching its own shell). Run them from the repo root; `pnpm --filter @pdf-generator/<dir> <script>` runs one package's script.

A fresh worktree's stack has no `node_modules`: run `T3CODE_WORKTREE_PATH=<path> wt-exec bash -lc "pnpm install --frozen-lockfile"` once before any other project command (until then `tsc` reports `Cannot find module 'zod'` and the like for every dependency). `wrangler dev` (`pnpm dev:print`) rebuilds on every save, and if it rebuilds a half-done edit it exits for good (`The Workers runtime failed to start … Uncaught ReferenceError`) instead of waiting for the next save: after multi-step edits check it still answers (`tmux capture-pane -p -t <wt>-print | tail`; a request failing with `ECONNREFUSED 127.0.0.1:8788`) and start it again. Biome lints every file in the worktree, even ones `.git/info/exclude` ignores: keep scratch output (`.scratch/` and the like) outside the worktree, for example in the container's `/tmp`. Template acceptance scripts take flags directly: `node src/acceptance.ts --url …` from the template's folder; `pnpm --filter … acceptance -- --url …` fails, because pnpm passes the `--` through to `parseArgs`.

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | TypeScript 7 (`tsc`) in every package |
| `pnpm test` | Vitest across every package, then the dev-container script tests |
| `pnpm exec vitest run --project @pdf-generator/<dir>` | One package's tests |
| `pnpm lint` | Biome check (whole repo) |
| `pnpm knip` | Unused files, exports, dependencies (all workspaces) |
| `pnpm check` | Apply Biome fixes |
| `pnpm verify` | Everything CI runs: typecheck, lint, knip, test |
| `pnpm dev --ip 0.0.0.0` | `vite dev` for `apps/web` (TanStack Start via `@cloudflare/vite-plugin`; `--ip` maps to Vite's `--host`; port 8787, the worktree's `app` URL). Local sign-in: `/__access/login`; scripts send `CF-Access-Client-Id: local-dev.access` and `CF-Access-Client-Secret: local-dev-secret` (dev only). Every hot reload of server code signs the browser out (the local stand-in makes a new key per module load): sign in again |
| `pnpm --filter @pdf-generator/web db:generate` | Generate a D1 migration from the Drizzle schema (never hand-write one) |
| `pnpm --filter @pdf-generator/web db:migrate:local` | Apply migrations to the local D1 (`db:migrate:remote` hits the real account: needs the user's OK) |
| `pnpm --filter @pdf-generator/web build` / `preview` | Production build, served locally (fails closed with 503 until Access vars are set) |
| `pnpm dev:print --ip 0.0.0.0` | `wrangler dev` for `apps/print` (port 8788, inside the stack only) |
| `pnpm cf-typegen` | Regenerate every Worker's binding types after changing its `wrangler.jsonc` |
| `pnpm pdf-to-png <pdf> [--gt <gt.json>] [--out <dir>] [--scale <n>]` | Draw each PDF page as a PNG, optionally with the gt.json boxes over it (`packages/dev-tools/README.md`); keep `--out` outside the worktree, in the container's `/tmp` |
| Batch locally (two tmux sessions) | print: `CI=1 XDG_CACHE_HOME=<writable dir> pnpm dev:print --ip 0.0.0.0 --var PRINT_TOKEN:<token> --var ASSET_ORIGIN:http://127.0.0.1:8788`; web: `pnpm dev --ip 0.0.0.0` (`wt-up` sets `MINIFLARE_REGISTRY_PATH` and `WRANGLER_REGISTRY_PATH` for you; a stack started before 2026-10-24 16:00 lacks the first: rerun `wt-up <path>`) with the same token as `PRINT_TOKEN` in `apps/web/.env` (gitignored). On a fresh stack run `db:migrate:local` first, or uploads answer `storage_error`. The stop recipe's `pkill workerd` stops both dev servers' workerd: restart both. Don't put print values in `apps/print/.env`: its own tests load it. To reproduce one fixture of a batch (its record and the HTML that was printed) without rerunning the batch, take the same path the batch does: `fixtureSeed(seed, index)` and `render(pack, record)` in `apps/web/src/batch/fixture.ts`, with `generate()` from `@pdf-generator/fake-data` in between |
| `pnpm --filter @pdf-generator/contract schemas` | Regenerate the committed JSON Schema after a contract change (a test fails when it is stale) |

## How work is organized

- **One ticket = one T3 thread = one worktree = one branch = one PR.** Ticket sizes were settled when the tickets were cut; don't stop or split a ticket because its diff is large. State the size in the PR (production code, tests, fixtures, generated files).
- A **coordinator** thread (the user's main conversation, in the main checkout) tracks every ticket, starts **worker** threads, relays their questions to the user, and merges PRs. Workers never talk to the user directly; they talk to the coordinator.
- A ticket may start once every ticket in its **Blocked by** has merged. Anything else it needs that isn't merged yet is replaced by a **stub** behind the same interface. Don't wait for it, and don't build it.
- Every ticket runs the same loop: `/plan-it` → 3–5 slices → per slice, red tests first (written by a different model) → implement → verify on the real stack; after the last slice, one code review of the whole ticket (by a different model) → PR. Workers run it as slash commands, starting with `/work-ticket`, which names the rest.

| Skill | Who uses it |
| --- | --- |
| `coordinate-tickets` | The coordinator: status, dispatch, relaying, merging. |
| `work-ticket` | A worker thread, from its first message to the merged PR. |
| `cross-model-delegate` | Anyone handing tests or reviews to a different model. |

### Models

| Role | Model | Fallback when its credit or quota runs out |
| --- | --- | --- |
| Coordinator, worker (planning, implementation) | Claude Opus 5.5, effort medium | none |
| Test author, every review lens | GPT-6.1-Sol (Codex), reasoning medium | Grok 4.7, reasoning high; then Claude Sonnet 5.5, effort high |

The test author and reviewers are always a different model from the implementer, so a misunderstanding isn't shared between the code and its tests. Keep your own context short (`| tail -n 40` on long output, `git diff --stat` before a full diff): most of the Claude spend is workers rereading their own long histories. `cross-model-delegate` says how to call them and when to fall back.

## Rules

These hold for every ticket. A ticket's "不做" (out of scope) list adds to them.

### Scope

- Build only what the ticket's 目標 says. Its 不做 list is binding. Something else that needs doing goes into your report as a proposed new ticket.
- **The shared contract (T02's zod schemas) changes only in its own small ticket.** If your ticket needs a contract change, stop and report it; don't change it in a feature PR.
- Template tickets (T22–T26) don't change platform code. A platform bug you find becomes a proposed ticket.
- Don't edit `docs/tickets.md`, this file or `.claude/skills/`. Propose changes in your report; the coordinator applies them.

### Generated files

- **D1 migrations are always generated by Drizzle (`drizzle-kit generate`), never hand-written or hand-edited.** On a conflict: rebase, delete your branch's generated migration, and generate it again. The same goes for `pnpm-lock.yaml`: rebase, then `pnpm install` to regenerate it; never merge lockfile conflict markers by hand.
- Don't commit build output, `.wrangler/`, or downloaded fonts that the pack spec doesn't require.

### Quality bar

- Determinism is a feature: same seed and template version → byte-identical data and the same `gt.json`. Never use unseeded randomness, wall-clock time or iteration order you don't control in the generation path.
- Taiwanese identifiers must be valid, not just plausible: 身分證字號 and 統一編號 check digits, real address and phone formats.
- Coordinates are read only after Paged.js has finished paginating. How to detect that comes from T03's write-up; follow it rather than guessing.
- Done means demonstrated on the running stack with recorded evidence (`verification-evidence`), not "tests pass".

### Environment

The VM's own rules (`~/.config/devvm/AGENTS.md`, loaded for you) win over anything here on how to run things: your stack, `wt-*` tools, worktree URLs, no host ports, no work outside your worktree. In short: `wt-status` first, `wt-up <your path>` when there is no stack, project commands through `T3CODE_WORKTREE_PATH=<path> wt-exec …`, verify on `https://app-<wt>.pdf-generator.liaoann.net`.

To see what a page or a rendered PDF looks like, use T3's preview tools (`preview_open`, `preview_snapshot`, `preview_click`, …) on your worktree URL; they reach it over the tailnet and need no OK. Use them for every visual check: layout, pagination, boxes drawn over a page. The preview browser downloads a PDF instead of showing it: to look at one, run `pnpm pdf-to-png` in your stack (with `--gt` to see the ground-truth boxes) and read the PNGs.

### External services: always ask, through the coordinator

Every call that reaches the user's Cloudflare account needs the user's OK **each time**: `wrangler deploy`, any `--remote` flag, real Browser Rendering, remote D1/R2, Cloudflare Access, `wrangler whoami`. Local `wrangler dev` (Miniflare's D1, R2 and Queues) needs no OK. A worker asks the coordinator, who asks the user. State the intent, read or write, the exact command and the expected result. Design your verification to work locally whenever it can.

### Git

- Branch `tNN-<short-slug>` (for example `t05-fake-data`), made when the thread was created. Commit only your own ticket's work.
- One commit per finished slice, conventional style matching the history (`feat: …`, `fix: …`, `test: …`, `build: …`), with a `Ticket: TNN` line in the body. Never commit a red test suite.
- Workers may push their own branch (`--force-with-lease` after a rebase) and open a PR against `main`. Workers never merge; the coordinator does.
- Run git only on the VM as `git -C <your worktree path> …`.
