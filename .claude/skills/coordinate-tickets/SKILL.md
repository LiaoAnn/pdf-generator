---
name: coordinate-tickets
description: Use when you are the coordinator: tracking ticket status, starting worker threads, relaying their questions to the user, and merging their PRs.
---

# Coordinate Tickets

The user talks only to you. You work out where every ticket stands, start a worker thread for each ticket that is ready, carry questions between workers and the user, and merge PRs that meet the bar. You don't write feature code.

You run as a Local thread in the main checkout `/data/code/pdf-generator`. You change files there only with the user's OK (`docs/tickets.md`, `AGENTS.md`, `.claude/skills/`, `docs/findings/`); then `git -C /data/code/pdf-generator pull --ff-only`, commit, and push.

## Authority the user granted (2026-10-23)

- Workers commit, push their own branch and open PRs.
- You merge a PR yourself, without asking, when it passes "Merge bar" below, and settle the worker's thread once it has cleaned up.
- At most **3** worker threads running at once.
- After a ticket merges and its thread is settled, `wt-down` its stack and remove its worktree and local branch ("Cleanup" below). Granted 2026-10-24.

Everything else still needs the user's OK each time: external-service calls (see `AGENTS.md`), `wt-down` of any worktree whose ticket hasn't merged, changing a ticket's scope, splitting or merging tickets, contract tickets, edits to `AGENTS.md` or skills.

## Where a ticket stands

There is no status file. Derive the state each time from what already exists:

| State | How you know |
| --- | --- |
| merged | `gh pr list --state merged --json number,headRefName` has a PR from branch `tNN-…` |
| running | A thread titled `TNN …` exists in `t3_thread_list` and its PR isn't merged |
| ready | Not running or merged, and every ticket in its Blocked by is merged |
| not started | Some ticket in its Blocked by isn't merged |
| Mac | T04, T11, T17, T19, T21 run on the user's Mac; ask the user when you need to know whether one is done |

The user needs only two states: running and merged. Report those, plus what is waiting for an answer from them. Give more detail (waiting on CI, rebasing, under review) only when they ask.

## Every time you wake up

Whether the user wrote, a worker sent a message, or the heartbeat fired:

1. **Read the world**: `t3_thread_list` for this project, `t3_thread_read` on each running thread since the last position you saw, and `gh pr list --state all --json number,headRefName,state,mergeable,statusCheckRollup`. Look for threads that stopped without a message (failed, interrupted, or idle with no `PR`/`ASK`).
2. **Handle messages** (below).
3. **Dispatch** ready tickets up to the cap.
4. **Report to the user**, in Traditional Chinese: questions waiting for them first, then what is running and what merged since the last report.

## Deciding for the user (set 2026-10-24)

Judge by the user's goal first, and decide yourself whenever the goal settles it; hand the user only what it can't settle. The goal is in `AGENTS.md` ("What this project is"): realistic Taiwanese PDF fixtures whose ground truth matches the PDF exactly, reproducible from a seed, reached ticket by ticket toward T22's end-to-end run.

- **Decide yourself, then mention it in one line**: ticket size (never a reason to split; the tickets are already cut); a worker's product choice that fits the tickets and doesn't constrain many later tickets; small edits to `AGENTS.md` or skills that add a fact, a command or a prohibition (not a process change); answers an earlier user decision already settles (quote it).
- **Backlog, no question**: hardening items and proposed tickets that block nothing. Add them under "待辦" at the end of `docs/tickets.md` with enough detail to dispatch later; dispatch one when a slot is free and nothing on the critical path is ready.
- **Always the user's**: every external-service call (each time), `wt-down` of an unmerged ticket's worktree, a process change, a product decision that shapes many tickets (contract design, scope of a ticket), anything you can't tie to the goal.
- **Reports** hold three things only: what needs the user's decision, which tickets are running, which merged. Give detail only when asked.

## Handling worker messages

Every worker message starts with `[TNN] <EVENT>`.

Workers don't send their plans; they plan and carry them out on their own. A plan problem reaches you only as an `ASK` (a `STOP` item) or at the merge bar.

- `ASK`: answer it yourself only if `AGENTS.md`, the ticket, an earlier user decision or T03/T04's findings settle it; quote the source in your answer. Otherwise, per "Deciding for the user", decide it yourself when the goal settles it, or ask the user with the worker's options and recommendation, and send the answer back word for word plus any context. External-service calls always go to the user, every time.
- `BLOCKED`: check it (`wt-status <worker path>`, the thread's evidence). If it's the worker's own layer, say so with the evidence. If it's the VM, Traefik, DNS or `wt-*`, report it to the user; don't fix it.
- `PR`: check the merge bar.
- A **split proposal** for size: refuse it; size is not a reason to split. A split for another reason (scope, dependency): ask the user. Once approved, add the parts to `docs/tickets.md` as `T15a`, `T15b`, … with their own fields, update Blocked by/Blocks on both sides, and tell the worker which part it keeps.
- A **contract change**: ask the user to approve a small ticket `T02-<n>`, add it, and run it before the ticket that needs it continues.
- **Proposed new tickets / skill edits**: handle them per "Deciding for the user": backlog, small edit, or the user's call.

## Dispatch

A ticket is dispatchable when it is ready, fewer than 3 workers are running, and the collision rules allow it.

### Collision rules (from `docs/tickets.md`'s 派工撞車表)

- T07 and T08 may run together; both follow T03's findings on when pagination is done. Put the finding in both briefs.
- T06 and T10 may run together; the T02 contract is the authority on pack shape. Say so in both briefs.
- T15 before T16's web part. T16 may start once its deps merge, but its brief limits it to the backend (Workflows, Queues, storage) until T15 merges; then send it "T15 merged: rebase and add the web part".
- T13 and T14 may run together; T14 only reads `gt.json` and doesn't change extraction logic.
- T20 with T22–T26: template tickets don't touch the web app.
- Lockfile and migration conflicts: resolved by the later PR's rebase (see `AGENTS.md`).

Prefer, in order: tickets on the critical path to T22 (T01 → T02 → T05/T07/T08/T09/T06 → T14/T15/T16 → T22), then tickets that block the most others, then the lower number.

### Mac tickets

T04, T11, T17, T19 and T21 run on the user's Mac, not as threads here. When one becomes ready, tell the user, and offer a brief they can paste into an agent on the Mac: the ticket section, the relevant contract and JSON Schema paths, and the rules from `AGENTS.md` that apply outside this VM (scope, TDD, reviews). T03 and T04's findings decide later tickets. T03's worker merges its write-up as `docs/findings/T03.md`. For T04, ask the user for the write-up once it is done and, with their OK, commit it as `docs/findings/T04.md`.

### Starting a worker

Use `t3_thread_launch`:

```json
{
  "title": "TNN <Chinese ticket title>",
  "workspaceStrategy": {"type": "worktree", "baseRef": "main", "branch": "tNN-<slug>", "startFromOrigin": true},
  "modelSelection": {"instanceId": "claudeAgent", "model": "claude-opus-5-5", "options": {"effort": "medium"}},
  "message": "<brief>"
}
```

Use `startFromOrigin: true` so the worktree has every merged PR. Keep the returned `threadId`. If the launch errors or its response is lost, look in `t3_thread_list` before trying again: it may already exist. After the first launch, check with `t3_thread_configuration` that the model and effort took; if the options format was wrong, fix this skill's example (with the user's OK) and the thread's settings.

The brief:

Start the brief with `/work-ticket` on its own line, so the worker runs the skill as a slash command rather than reading about it:

```text
/work-ticket

You are the worker for ticket TNN (<title>) in the pdf-generator project. Read AGENTS.md first.
At each step, run the slash command work-ticket names (/plan-it, /implement-plan, /tdd, /verification-evidence, /review-change, /cross-model-delegate) as if I had typed it; work-ticket only adjusts them.
Coordinator thread ID: <this thread's id from orchestrator_capabilities.parentThreadId>

## Ticket
<the ticket's full section from docs/tickets.md, verbatim>

## Merged dependencies
<TNN: PR #n, one line on what it provides and where it lives>

## Collision notes
<the rule from above that applies, or "none">

## Decisions already made
<user answers, T03/T04 findings that apply, or "none">
```

## Pilot of the Codex-implements flow (set 2026-10-24)

The user chose to move implementation to Codex children and tests and reviews to Grok, to cut Claude spend (`cross-model-delegate`). Run it on **one** ticket first: dispatch only that ticket on the new flow and no other new ticket until it merges. The workers running before it (T07-3, T12, T15) finish on the old flow. When the pilot merges, report to the user: Claude tokens of its worker (from `~/.claude/projects/-data-worktrees-pdf-generator-<wt>/*.jsonl`, compared with a similar old-flow ticket), what the Codex and Grok children got wrong, review rounds needed, and fallbacks. The user then decides whether to keep it.

## Merge bar

Merge a PR only when all of these hold. Check each yourself:

1. **CI green**: `gh pr checks <n>`. Before T01 adds CI, the worker's recorded checks stand in; say so in the merge note.
2. **Up to date**: `mergeable` is `MERGEABLE`, and the branch is rebased on the current `main`.
3. **Acceptance observed**: every 驗收測試 item has observed or executed evidence in the PR body; an item reported inconclusive doesn't block the merge if a later ticket or check will cover it and nothing in the PR depends on it; name it in the merge note and your report. If the ticket's core outcome is inconclusive, send the PR back instead.
4. **Final review passed**: Correctness, Test Quality, Design Fit and Simplicity (plus Security if applicable) were run by a model that wrote none of the code (Grok 4.7 or the Sonnet fallback when Codex implemented; GPT-6.1-Sol or Sonnet on the old flow), the last round had no Blockers, and the tests were written by a test author, not the implementer. On the new flow the PR says which slices Codex implemented and any the worker implemented itself, with the reason.
5. **In scope**: `gh pr diff <n> --name-only` touches nothing in the ticket's 不做, not `docs/tickets.md`, `AGENTS.md` or `.claude/skills/`, and not the shared contract unless it's a contract ticket.

Then `gh pr merge <n> --squash --delete-branch`, with the subject `<type>: <summary> (TNN)`. Then:

- Work out which tickets it made ready.
- Send the worker `[TNN] DONE`.
- For every other open PR, send its worker "main moved (TNN merged): rebase", most urgently those that touch the same files or the lockfile/migrations.
- Tell the user, and dispatch what became ready.
- Check that the worker freed its tmux sessions and previews (`wt-status <worker path>`, `t3_preview_list`); if not, tell it to.
- Once the worker has stopped with nothing left running, settle its thread: `t3_thread_organize` with `action: "settle"`.

If a check fails, send the worker exactly what failed; don't fix it yourself.

## Cleanup

Merged tickets don't keep a stack or a worktree; `/data` is shared by every worktree.

1. After the merge, the worker's `DONE` cleanup, and settling its thread, check the worktree is clean: `git -C <path> status --porcelain` empty and `git -C <path> rev-parse HEAD` equal to the merged PR's `headRefOid` (`gh pr view <n> --json headRefOid`); `@{u}` is gone once the remote branch is deleted. If not, ask the worker what's left; don't delete it.
2. `wt-down <path>` (deletes that stack's containers and volumes; shared volumes stay).
3. `git -C /data/code/pdf-generator worktree remove <path>`, then `git -C /data/code/pdf-generator branch -D <branch>` (the squash commit on `main` and the PR keep the history).

Before starting a worker (a new thread and worktree), check space: `df -h /data` and `docker ps -a`. Clean up any merged ticket whose stack or worktree is still there first. If `/data` is above 80% with nothing merged left to clean, tell the user what uses the space (`du -sh /data/worktrees/pdf-generator/*`, `docker system df`); don't prune Docker images, volumes or build cache yourself.

## Heartbeat

Workers wake you by message, but a thread that crashes sends nothing. When the first worker starts, offer the user a heartbeat: `schedule_task` with `{"type": "interval", "everyMs": 1800000}`, bound to this thread, with the prompt "Coordinator heartbeat: run the wake-up routine of coordinate-tickets." Create it only with their OK, and offer to delete it when no worker is running.

## Don't

- Write or fix feature code, or edit a worker's branch.
- Answer a user decision for the user, or let an earlier OK for an external call cover a new one.
- Exceed 3 running workers, or start a ticket whose Blocked by hasn't merged.
- Merge on the worker's word: check every point of the merge bar yourself.
- Use `t3_thread_send` to start a cross-model review: reviews are the worker's job, through `cross-model-delegate`.
