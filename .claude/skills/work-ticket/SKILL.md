---
name: work-ticket
description: Use when you are a worker thread given a ticket (TNN) by the coordinator, from the first message until the PR is merged.
---

# Work Ticket

You own one ticket from `docs/tickets.md`, in your own worktree and branch, until its PR merges. You run the flow, plan, and write the tests; Kimi K3 implements each slice and runs the long jobs (probes, `pnpm verify`, acceptance batches, re-checks after a rebase, the PR draft); GPT-6.1-Sol reviews the whole ticket (`/cross-model-delegate`). The coordinator decides what runs when, the user decides through the coordinator.

This skill sets this project's rules for the global `/plan-it`, `/implement-plan`, `/tdd` and `/review-change`; where they differ from this skill, this skill wins.

**Every `/name` in this file is a slash command: when you reach that step, run it, exactly as if the user had typed `/name` (invoke the Skill tool with `name`).** This file only adjusts those skills; their content isn't here, so reading this file is not running them. Each one shows up in your thread as a `Skill: <name>` call:

| Step | Run |
| --- | --- |
| 2. Plan | `/plan-it` |
| 3. Implement | `/implement-plan`, then `/tdd` at each Red step |
| Before the first delegation | `/cross-model-delegate` |
| Each Acceptance | `/verification-evidence` |
| The final review (step 4), not per slice | `/review-change` |
| An unexplained failure | `/diagnose-bug` |
| A Drizzle schema or migration | `/drizzle-orm` |

## Your brief

The coordinator's first message gives you: the ticket ID and its full section from `docs/tickets.md`, the **coordinator thread ID**, which dependencies have merged, the collision notes for this ticket, and anything the user decided. If the ticket ID or the coordinator thread ID is missing, send nothing anywhere: stop and say so in your thread.

## Talking to the coordinator

You never ask the user directly and never use `AskUserQuestion`. Every message for the user goes through the coordinator with `t3_thread_send` (`threadId` = coordinator, `mode: "auto"`, `clientRequestId` `<TNN>-<event>-<n>`). Start every message with `[TNN] <EVENT>`:

| Event | When | Then |
| --- | --- | --- |
| `ASK` | A decision blocks you: scope, a design choice the plan didn't settle, an external-service call, a test dispute, a ticket split | End your turn and wait for the answer |
| `PR` | The PR is open and the final review passed | Wait; fix whatever comes back |
| `BLOCKED` | Something outside your worktree is broken (see "When something doesn't work" in `~/.config/devvm/AGENTS.md`) | End your turn and wait |
| `DONE` | The coordinator told you the PR merged | Stop |

An `ASK` holds one question, its options, your recommendation and why, and what you will do with each answer. For an external-service call, add what `AGENTS.md` lists: intent, read or write, the exact command, the expected result. Then end your turn. Answers arrive as a new message in your thread.

## 1. Start

1. Run `wt-status` (no argument), then `wt-status <path>`. Note your path and `<wt>`.
2. If there is no stack: check `git -C <path> status` for changes you didn't make to `.devcontainer/` or compose files (stop and send `BLOCKED` if there are any), then `wt-up <path>`.
3. Read `AGENTS.md`, your ticket in `docs/tickets.md`, the sections of the tickets in its Blocked by, and the code they merged. That code is your foundation; build on it rather than beside it.

## 2. Plan: `/plan-it`

Run `/plan-it` and follow it, with these settings:

- **Why**: the ticket's 目標 plus the line in `AGENTS.md`'s "What this project is" it serves. Don't ask the user for the Why; the ticket is it.
- **Acceptance**: the ticket's 驗收測試 is the minimum. Every item maps to at least one slice's Acceptance.
- **Slices**: 3–5. Each is committed on its own and fits the ticket's 不做 list.
- **Size**: not a reason to stop or split; the tickets are already cut. Report the breakdown (production, tests, fixtures, generated) in the PR.
- **Stubs**: for anything the ticket needs that isn't in its Blocked by and isn't merged, define the interface and a stub, and name in the plan which future ticket replaces it.
- **Test-first**: TDD for every slice that changes behavior. You write the tests; Kimi K3 implements (step 3). Write each slice's Approach and Boundary concretely enough that Kimi needs no other context.
- **Commits**: one per slice, automatically, once the slice passes step 3.
- **Feasibility**: check unobserved dependencies for real, but only locally. A check that needs the real Cloudflare account is an `ASK`.

`STOP` items: a change to the shared contract; a call to an external service; work outside the ticket's goal; a conflict with T03's or T04's findings. Don't send the plan to the coordinator; carry it out yourself. Only a `STOP` item goes to the coordinator, as an `ASK`, and you wait for the answer before the work it affects.

Save the plan as the first section of your PR description later. Don't commit it to the repo.

## 3. Implement: `/implement-plan`

Run `/implement-plan` and follow its slice loop, with these changes:

1. **Red: you write the tests** for every behavior-changing slice (keep drafts for later slices on the VM outside `/tmp`, e.g. `~/drafts/<wt>/`: `/tmp` is cleared when the VM restarts, T08-5), with `/tdd` and the rules in `/cross-model-delegate` ("Writing the tests"). Confirm RED, and that the package typecheck and `pnpm lint` pass on them, before you hand off. A slice owed no new test (`/tdd`'s test-judgment) records its exemption; don't manufacture one.
2. **Implement: Kimi K3**, through `/cross-model-delegate`'s implementer brief (async; end your turn while it works). It may not edit tests. When it reports, check its diff and rerun the tests; send problems back to it, fixing only small things yourself and listing each, per "After the implementer reports". If Kimi is unavailable, implement the slice yourself and record the fallback.
3. **Green**: the slice's tests and the tests near the change, through `wt-exec`.
4. **Mechanical checks**: `pnpm verify` (typecheck, lint, knip, test: everything CI runs; not `pnpm ci`, which in pnpm is a clean reinstall). The VM's RAM is shared by every worktree and has no swap, and three parallel test runs have run it out of memory twice (once taking the shared Codex process down with it). **Run every heavy command under the VM's heavy lock so worktrees take turns**: `wt-bg <path> verify --heavy --timeout 40m -- pnpm verify`. **Per slice, only the touched packages' checks**: their tests (`pnpm exec vitest run --project @pdf-generator/<dir>`, heavy if it starts a browser), their typecheck, and Biome on the changed files; Kimi runs them in its implementer brief. **The full `pnpm verify` runs once per ticket**, after the final rebase (step 4.3) and before the PR, by Kimi as a runner job; you read the log's last lines yourself (`tail -n 30`). Exception: a slice that touches `packages/contract`, `pnpm-lock.yaml`, a shared config (`tsconfig.base.json`, `biome.json`, knip, vitest workspace) or many packages runs the full verify itself. A full verify takes 20–30 min plus the lock queue (set 2026-11-04 with the user; before, every slice ran it). When you run a long job yourself, wait for it in the background (see "Don't"). Heavy means `pnpm verify`, `pnpm test`, any browser test, an acceptance batch; a single small test file doesn't need the lock. The lock is held until the container command really stops, and `--timeout` stops the container command, so don't build your own `flock` or host-side `timeout` (T07-20: the old host-side `timeout … flock … wt-exec` left the container command running without the lock). Stop dev servers you don't need before the run. Never hold the lock while waiting on anything else, such as a subagent or an answer. One test alone can also exhaust the RAM: a test that copied a fixture's font 65,540 times needed ≈12 GB once the font was real (T06-1); watch a new or changed fixture's effect on tests that copy it.
5. **Acceptance** on your running stack, per the plan. You design each check and its pass criterion; **Kimi runs the long ones** (acceptance batches, the 6-template gt.json comparison, probes) through `/cross-model-delegate`'s runner brief and returns a short summary with the commands, the numbers and the paths of the logs and outputs. Read the key evidence yourself (log tails, the counts, a rendered page), not only its summary. Examples: a real request to `https://app-<wt>.pdf-generator.liaoann.net`, a CLI run, a rendered PDF opened and checked, a browser flow with screenshots. Do visual checks with T3's preview tools on the worktree URL. Run `/verification-evidence` and record evidence as it says. Where the real check needs an external service you haven't been cleared for, report it **inconclusive** with the reason; don't work around it.
6. **No per-slice review.** Skip `/implement-plan`'s step 6: code review runs once, over the whole ticket, in step 4 below.
7. **Commit**: `git -C <path> commit` per `AGENTS.md`'s Git rules.

A surprise whose cause isn't obvious goes through `/diagnose-bug` before more editing. A slice that outgrows its Boundary stops and re-cuts the plan; if the new plan has a `STOP` item, send an `ASK`.

## 4. Finish

1. **Whole-ticket acceptance**: rerun every 驗收測試 item end to end on the stack, after the last slice, with evidence.
2. **Final review** (the only code review): run `/review-change` over `origin/main...HEAD` with Correctness, Test Quality, Design Fit and Simplicity, plus Security if applicable, each lens a subagent through `/cross-model-delegate`, in parallel. Fix confirmed Blockers, rerun the tests, checks and acceptance for what each fix touched, and start a new round for those lenses until one reports none.
3. **Rebase** (you; git is yours) onto the latest `origin/main` (`git -C <path> fetch origin && git -C <path> rebase origin/main`). For conflicts in `pnpm-lock.yaml` or D1 migrations, follow `AGENTS.md`'s Generated files rules, then have Kimi run the full `pnpm verify` (runner brief; the ticket's one full run, step 4 above) and the acceptance re-checks the rebase could affect.
4. **PR**: `git -C <path> push -u origin <branch>`, then `gh pr create --base main` with the body below. Kimi may draft it (runner brief) into `/tmp/<wt>/pr-body.md` from the slice reports and evidence paths; you check every claim in it against the evidence and edit it before you open the PR:
   - title `TNN: <ticket title in English>`
   - body: plan (Why/How/What), per-slice report (`implement-plan`'s Output format), whole-ticket acceptance evidence, final review result (lenses run, Blockers fixed, residual risk, which model ran each and any fallback), who implemented each slice (Kimi or your fallback) and every small fix you made, stubs left for future tickets, proposed new tickets, proposed edits to `AGENTS.md` or skills.
   Register it with `link_pull_request`.
5. Wait for CI (`gh pr checks <n> --watch`). Fix a failure caused by your change; report one that isn't as `BLOCKED`.
6. Free your runtime before you send it: stop the dev servers (AGENTS.md stop recipe), kill your tmux sessions, close your T3 previews. Start them again only if a review comment or rebase needs them. Then send `PR` with the PR URL, the CI result, and a 5-line summary: what it does, acceptance result, review result, open risks, anything inconclusive.

## 5. Until merged

- **Rebase requests**: when the coordinator says `main` moved, redo step 4.3, rerun tests and checks, push with `--force-with-lease`, and reply `PR` with the new CI result.
- **Review comments**: fix them like Blockers (tests, checks, acceptance for what changed), then reply `PR`.
- After `DONE`, free what you hold: kill every tmux session you started (`tmux ls`, then `tmux kill-session -t <wt>-<role>`), close the T3 previews you opened (`t3_preview_list`, `t3_preview_close`), and check with `wt-status <path>` that none remain. Leave the stack itself; don't run `wt-down`: the coordinator removes your stack and worktree after the merge.

## Don't

- Merge your own PR, push to `main`, or touch any branch but yours.
- Run any git command inside the container, not even `git init` in `/tmp`. Git runs only on the VM as `git -C <path> …`; for a clean copy use `git -C <path> archive` or `git -C <path> worktree add` on the VM.
- Edit `docs/tickets.md`, `AGENTS.md` or `.claude/skills/`. Propose instead.
- Change the shared contract, or fix another ticket's code in passing. Propose instead.
- Let the implementer change a test, make more than a small fix to its code yourself (list each one you make), or skip a review round because the last one "was probably fine".
- Paste long output into your thread: `| tail -n 40` on test and build commands, `git diff --stat` before a full diff, `maxCharsPerItem` when reading threads. Your context length is what the ticket costs.
- Call the real Cloudflare account without an answered `ASK`.
- Report a step as passed when its evidence is weaker than it needs; say inconclusive.
- Hold one tool call for more than about 2 minutes. A message from the coordinator or a child is read only when your current tool call returns, so a 10-minute foreground `pnpm verify` delays it 10 minutes (T05-2), and by then a "stop, main changed" can come too late. Long runs go to Kimi first (see step 3). One you run yourself starts with `wt-bg <path> <name> [--heavy] [--timeout …] -- <cmd>` (or `--script <file>`); then wait with **one** background Bash call, `wt-wait <path> <name> --max 1500` with `run_in_background: true`, and end your turn. Claude Code wakes you when that command exits (its last line is `exit=<code>`; 75 means still queued or running past 1500 s: start another background wait). Coordinator messages reach you meanwhile; if one says to stop, `wt-stop <path> <name>`. Don't poll `wt-wait` in the foreground: each poll rereads your whole conversation, and on 2026-11-02 foreground polls were 277 of 1,002 worker tool calls (T14-10: 103 of 259). The hook refuses a foreground `wt-wait`. Waiting on a `delegate_task` child or a coordinator answer by ending your turn is fine too: those wake you.
- Write commands that stop on a permission prompt. Nobody watches your thread, so a prompt can wait for hours (T07-23: 11 hours on "This shell -c script runs rm and could not be checked"; T07-25 and T07-2 the next day). Anything with several steps, `rm`, pipes or quotes goes in a script file: write it with the Write tool outside the worktree (for example `/tmp/<wt>/run.sh` on the VM) and run it with `wt-bg <path> <name> --script /tmp/<wt>/run.sh` (it runs in the container from the workspace root). `--script` copies the file without its extension, so a `.mjs` script fails with `ERR_UNKNOWN_FILE_EXTENSION`: make the script bash, and have it write the `.mjs` file inside the container and run it (T07-31). Never put `rm` (any flags), `eval` or nested quoting in a `bash -c`/`bash -lc` string, including one passed to `wt-exec` or `tmux new`. Start a dev server with `tmux new -d -s <wt>-<role> -- env T3CODE_WORKTREE_PATH=<path> wt-exec <cmd…>` (no quoted string) and stop it with `tmux kill-session -t <wt>-<role>`, which now stops its container processes too; don't `pkill` in the container: your delegated children share it (T07-25 killed a test author's Chrome). A hook (`.claude/hooks/bash-guard.py`) refuses these shapes, a foreground `pnpm verify`/`pnpm test` and the old lock file before they run, and says what to use; rewrite the command, don't work around it. When a command still needs approval, its description must say why it is needed, what it changes, the result you expect and how you will check it, so the user can approve it without reading your thread.
- Leave dev servers running while you wait on a subagent, the coordinator or the user. Stop them first with the stop recipe in `AGENTS.md` and start them again when you need them. On 2026-10-24 a worker kept wrangler and vite (about 2.2 GB) running while it waited on its test author, and the VM ran out of memory: the OOM killer took down the shared Codex process.
