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
- The monorepo layout, stack and commands are created by T01. Until T01 merges, the repo is a single-Worker template (`src/index.ts`, `wrangler.jsonc`, Biome, Knip, TypeScript 7).

<!-- T01: replace this list with the real package map and the commands below. -->

## Commands

Run every project command inside your worktree's stack (see "Environment"), never on the VM host.

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Biome check |
| `pnpm knip` | Unused files, exports, dependencies |
| `pnpm check` | Apply Biome fixes |
| `pnpm cf-typegen` | Regenerate Worker binding types after changing bindings |

T01 adds the test, typecheck and CI commands; until then a ticket states its own.

## How work is organized

- **One ticket = one T3 thread = one worktree = one branch = one PR**, about 500–2000 changed lines (generated files such as lockfiles and migrations don't count). Over 2000: the ticket is split. Under 300: it is merged into another.
- A **coordinator** thread (the user's main conversation, in the main checkout) tracks every ticket, starts **worker** threads, relays their questions to the user, and merges PRs. Workers never talk to the user directly; they talk to the coordinator.
- A ticket may start once every ticket in its **Blocked by** has merged. Anything else it needs that isn't merged yet is replaced by a **stub** behind the same interface. Don't wait for it, and don't build it.
- Every ticket runs the same loop: `plan-it` → 3–5 slices → per slice, tests first (written by a different model) → implement → verify on the real stack → review (by a different model) → PR. The `work-ticket` skill has the details.

| Skill | Who uses it |
| --- | --- |
| `coordinate-tickets` | The coordinator: status, dispatch, relaying, merging. |
| `work-ticket` | A worker thread, from its first message to the merged PR. |
| `cross-model-delegate` | Anyone handing tests or reviews to a different model. |

### Models

| Role | Model | Fallback when its credit or quota runs out |
| --- | --- | --- |
| Coordinator, worker (planning, implementation) | Claude Opus 5.5, effort medium | none |
| Test author, every review lens | GPT-6.1-Sol (Codex), reasoning medium | Claude Sonnet 5.5, effort high |

The test author and reviewers are always a different model from the implementer, so a misunderstanding isn't shared between the code and its tests. `cross-model-delegate` says how to call them and when to fall back.

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

To see what a page or a rendered PDF looks like, use T3's preview tools (`preview_open`, `preview_snapshot`, `preview_click`, …) on your worktree URL; they reach it over the tailnet and need no OK. Use them for every visual check: layout, pagination, boxes drawn over a page.

### External services: always ask, through the coordinator

Every call that reaches the user's Cloudflare account needs the user's OK **each time**: `wrangler deploy`, any `--remote` flag, real Browser Rendering, remote D1/R2, Cloudflare Access, `wrangler whoami`. Local `wrangler dev` (Miniflare's D1, R2 and Queues) needs no OK. A worker asks the coordinator, who asks the user. State the intent, read or write, the exact command and the expected result. Design your verification to work locally whenever it can.

### Git

- Branch `tNN-<short-slug>` (for example `t05-fake-data`), made when the thread was created. Commit only your own ticket's work.
- One commit per finished slice, conventional style matching the history (`feat: …`, `fix: …`, `test: …`, `build: …`), with a `Ticket: TNN` line in the body. Never commit a red test suite.
- Workers may push their own branch (`--force-with-lease` after a rebase) and open a PR against `main`. Workers never merge; the coordinator does.
- Run git only on the VM as `git -C <your worktree path> …`.
