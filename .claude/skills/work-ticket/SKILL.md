---
name: work-ticket
description: Use when you are a worker thread given a ticket (TNN) by the coordinator, from the first message until the PR is merged.
---

# Work Ticket

You own one ticket from `docs/tickets.md`, in your own worktree and branch, until its PR merges. You plan, check and integrate; you don't write the code. A fresh Codex child implements each slice, another model (Grok, or the Sonnet fallback) writes the tests and reviews the result, the coordinator decides what runs when, and the user decides through the coordinator.

This skill sets this project's rules for the global `/plan-it`, `/implement-plan`, `/tdd` and `/review-change`; where they differ from this skill, this skill wins.

**Every `/name` in this file is a slash command: when you reach that step, run it, exactly as if the user had typed `/name` (invoke the Skill tool with `name`).** This file only adjusts those skills; their content isn't here, so reading this file is not running them. Each one shows up in your thread as a `Skill: <name>` call:

| Step | Run |
| --- | --- |
| 2. Plan | `/plan-it` |
| 3. Implement | `/implement-plan`, then `/tdd` at each Red step |
| Before the first delegation (tests, implementation, review) | `/cross-model-delegate` |
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
- **Test-first**: TDD for every slice that changes behavior. Tests come from a test author on another model (step 3).
- **Boundary**: each slice names the files and modules it may change; the implementer child works only inside it, so make it precise enough to hand over.
- **Commits**: one per slice, automatically, once the slice passes step 3.
- **Feasibility**: check unobserved dependencies for real, but only locally. A check that needs the real Cloudflare account is an `ASK`.

`STOP` items: a change to the shared contract; a call to an external service; work outside the ticket's goal; a conflict with T03's or T04's findings. Don't send the plan to the coordinator; carry it out yourself. Only a `STOP` item goes to the coordinator, as an `ASK`, and you wait for the answer before the work it affects.

Save the plan as the first section of your PR description later. Don't commit it to the repo.

## 3. Implement: `/implement-plan`

Run `/implement-plan` and follow its slice loop, with these changes:

1. **Red: every behavior-changing slice uses a test author**, not just high-risk ones. Run `/tdd` for the cycle and `/cross-model-delegate` for the test author brief. Rerun its RED yourself, and run the package typecheck and `pnpm lint` before you start the implementer: a test that doesn't compile, or an existing test the slice makes stale, goes back to the author first, because the implementer may not fix it and stops. You don't edit its tests; disputes go back to the author, then to the coordinator as an `ASK`. A slice owed no new test (`/tdd`'s test-judgment) records its exemption; don't manufacture one.
2. **Implement through a Codex child**: one fresh `delegate_task` per slice with `cross-model-delegate`'s Implementer brief. It makes the change and runs the tests and `pnpm verify` itself. Don't write the production code yourself: keeping the code out of your thread keeps your context short, and that is most of the Claude spend. You implement a slice yourself only when Codex is unavailable (its fallback rule); record that in the slice report.
3. **Check**: read `git -C <path> diff --stat`, then the diff. Rerun the slice's tests and the tests near the change through `wt-exec` yourself. A wrong or out-of-Boundary change goes back to a new implementer round with what is wrong; small fixes too (a rename, a lint error) so that the code stays the implementer's.
4. **Mechanical checks**: `pnpm verify` (typecheck, lint, knip, test: everything CI runs; not `pnpm ci`, which in pnpm is a clean reinstall). The implementer runs it each round; run it again yourself before the last slice's commit, and after a fix round whose report you doubt. The VM's RAM is shared by every worktree and has no swap, and three parallel test runs have run it out of memory twice (once taking the shared Codex process down with it). **Run every heavy command through the shared lock so worktrees take turns**: `flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=<path> wt-exec bash -lc "pnpm verify"`. Heavy means `pnpm verify`, `pnpm test`, any browser test, an acceptance batch; a single small test file doesn't need the lock. Stop dev servers you don't need before the run. Never hold the lock while waiting on anything else, such as a subagent or an answer.
5. **Acceptance** on your running stack, per the plan: a real request to `https://app-<wt>.pdf-generator.liaoann.net`, a CLI run, a rendered PDF opened and checked, a browser flow with screenshots. Do visual checks with T3's preview tools on the worktree URL. Run `/verification-evidence` and record evidence as it says. Where the real check needs an external service you haven't been cleared for, report it **inconclusive** with the reason; don't work around it.
6. **No per-slice review.** Skip `/implement-plan`'s step 6: code review runs once, over the whole ticket, in step 4 below.
7. **Commit**: `git -C <path> commit` per `AGENTS.md`'s Git rules.

A surprise whose cause isn't obvious goes through `/diagnose-bug` before more editing. A slice that outgrows its Boundary stops and re-cuts the plan; if the new plan has a `STOP` item, send an `ASK`.

## 4. Finish

1. **Whole-ticket acceptance**: rerun every 驗收測試 item end to end on the stack, after the last slice, with evidence.
2. **Final review** (the only code review): run `/review-change` over `origin/main...HEAD` with Correctness, Test Quality, Design Fit and Simplicity, plus Security if applicable, each lens a subagent through `/cross-model-delegate` (Grok, never Codex: it wrote the code), in parallel. Send each confirmed Blocker to a new Codex implementer round (Implementer brief plus the finding), then rerun the tests, checks and acceptance for what each fix touched, and start a new round for those lenses until one reports none.
3. **Rebase** onto the latest `origin/main` (`git -C <path> fetch origin && git -C <path> rebase origin/main`). For conflicts in `pnpm-lock.yaml` or D1 migrations, follow `AGENTS.md`'s Generated files rules, then rerun the tests and checks.
4. **PR**: `git -C <path> push -u origin <branch>`, then `gh pr create --base main` with:
   - title `TNN: <ticket title in English>`
   - body: plan (Why/How/What), per-slice report (`implement-plan`'s Output format), whole-ticket acceptance evidence, final review result (lenses run, Blockers fixed, residual risk, which model ran each and any fallback), stubs left for future tickets, proposed new tickets, proposed edits to `AGENTS.md` or skills.
   Register it with `link_pull_request`.
5. Wait for CI (`gh pr checks <n> --watch`). Fix a failure caused by your change; report one that isn't as `BLOCKED`.
6. Send `PR` with the PR URL, the CI result, and a 5-line summary: what it does, acceptance result, review result, open risks, anything inconclusive.

## 5. Until merged

- **Rebase requests**: when the coordinator says `main` moved, redo step 4.3, rerun tests and checks, push with `--force-with-lease`, and reply `PR` with the new CI result.
- **Review comments**: fix them like Blockers (a Codex implementer round, then tests, checks, acceptance for what changed), then reply `PR`.
- After `DONE`, free what you hold: kill every tmux session you started (`tmux ls`, then `tmux kill-session -t <wt>-<role>`), close the T3 previews you opened (`t3_preview_list`, `t3_preview_close`), and check with `wt-status <path>` that none remain. Leave the stack itself; don't run `wt-down`: the coordinator removes your stack and worktree after the merge.

## Don't

- Merge your own PR, push to `main`, or touch any branch but yours.
- Run any git command inside the container, not even `git init` in `/tmp`. Git runs only on the VM as `git -C <path> …`; for a clean copy use `git -C <path> archive` or `git -C <path> worktree add` on the VM.
- Edit `docs/tickets.md`, `AGENTS.md` or `.claude/skills/`. Propose instead.
- Change the shared contract, or fix another ticket's code in passing. Propose instead.
- Edit a delegated test, or skip a review round because the last one "was probably fine".
- Write production code yourself while Codex is available, or give a test or review to Codex in a ticket Codex implemented.
- Paste long output into your thread: `| tail -n 40` on test and build commands, `git diff --stat` before a full diff, `maxCharsPerItem` when reading threads. Your context length is what the ticket costs.
- Call the real Cloudflare account without an answered `ASK`.
- Report a step as passed when its evidence is weaker than it needs; say inconclusive.
