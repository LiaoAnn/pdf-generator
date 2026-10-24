---
name: cross-model-delegate
description: Use when handing a slice's implementation, test authoring or a review lens to another model, including fallback when that model's credit runs out.
---

# Cross-Model Delegate

Code comes from Codex children, and tests and reviews from a model that wrote none of the code, so a misunderstanding in the implementer isn't copied into its checks. The worker (Opus) plans, checks and integrates; keeping implementation out of its thread keeps its context short, which is where most of the Claude spend went. This skill says which model, how to call it, what the brief holds, and what to do when the call fails.

## Targets

Call T3's `delegate_task` (it may appear as `mcp__t3-code__delegate_task`). Don't use the native `Agent`/`Task` tool for these roles: it can only run Claude models.

| Role | Primary `target` | Fallback `target` |
| --- | --- | --- |
| Implementer | `{"providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": {"reasoningEffort": "medium"}}` | none: the worker implements the slice itself |
| Test author, review lens | `{"providerInstanceId": "grok", "model": "grok-4.7", "options": {"reasoningEffort": "high"}}` | `{"providerInstanceId": "claudeAgent", "model": "claude-sonnet-5-5", "options": {"effort": "high"}}` |

Never give a test author or review lens to Codex in a ticket where Codex implemented: they must be a model that wrote none of the code. (Tickets started before 2026-10-24 12:00 Taipei keep the old flow: the worker implements, Codex is the test author and reviewer, Sonnet the fallback.)

Before the first call in a thread, run `orchestrator_capabilities` once (with `search: "grok"` too, to list Grok's models) and check every model above is listed. If an ID changed, use the closest listed equivalent and say so in your report.

Common settings:
- `isolation`: leave unset (shared). The child works in your worktree and sees your files.
- `mode`: `"wait"` with `timeoutMs` 1800000 for an implementer, a test author or a single lens; for several lenses at once, start each with `"async"` and collect them with `task_status`. If a wait times out, keep the `taskId` and check `task_status` again; don't start a duplicate.
- `role`: `"implementation"` for an implementer, `"test"` for a test author, `"review"` for a lens.
- `clientRequestId`: `<ticket>-<slice>-<role>-r<round>`, for example `T05-s2-impl-r1`, `T05-s2-tests-r1` or `T05-final-correctness-r1`. Keep it stable across retries of the same round; a new round gets a new number.
- `title`: the same string as `clientRequestId`.

### When to fall back

Fall back to the role's fallback, with the same brief and a new `clientRequestId` ending in `-fb`, when the primary call or its task:
- fails with a quota, credit, usage-limit, rate-limit (after one retry 2 minutes later), authentication or "provider unavailable" error; or
- fails twice in a row for any other reason.

A transport error `read-process-exit-status` means T3's one shared Codex process has died (on 2026-10-24 the kernel's OOM killer killed it), and it stays down until the user restarts Codex in T3: every Codex call fails until then. Fall back at once without retrying, for the rest of the ticket, and tell the coordinator in your next message so it can ask the user to restart Codex.

Once the primary has hit a credit or quota limit, use the fallback for the rest of the ticket; don't probe the primary again. Record every fallback (which call, the error text) in your slice report. If both fail, stop and report to the coordinator.

The Sonnet fallback runs on the same Claude account as you: when you yourself hit the Claude usage limit, it is unavailable too. A fallback that failed for that reason is not a failure of the primary; retry the primary first once the limit resets.

Never run a test author or review lens yourself or on another Opus instance: the point is a model that wrote none of the code. Only the implementer falls back to you; when you implement a slice yourself, Grok or Sonnet still writes its tests and reviews it.

## What the child is told

The child starts with no history. It reads `AGENTS.md` (Codex does so on its own; say so for Grok and Claude) but not your conversation or your skills. Write a self-contained brief.

### Implementer brief

One fresh child per slice, and a fresh one for each fix round; don't continue an old implementer's thread. Run it with `mode: "wait"` once the slice's RED tests exist. It gets the slice and the tests, not your conversation:

```text
You implement slice <n> of ticket <TNN> in /data/worktrees/pdf-generator/<wt>.
Read AGENTS.md first; its rules bind you (scope, determinism, generated files, the heavy-test lock, no git in containers).
Why: <the plan's Why, 2-4 lines>
Slice outcome: <Outcome>
Boundary: <files and modules you may change; anything else is out of bounds>
RED tests to turn green (don't edit them, or any test you didn't write): <paths and the RED command>
Relevant code: <modules to build on, existing patterns to follow, stubs and their future tickets>
Constraints from the plan: <decisions, T03/T04 findings that apply, the ticket's 不做 items that touch this slice>

Make the smallest change that turns those tests green inside the Boundary. Run them through `T3CODE_WORKTREE_PATH=/data/worktrees/pdf-generator/<wt> wt-exec <test command>`, then `flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=/data/worktrees/pdf-generator/<wt> wt-exec bash -lc "pnpm verify"`, and fix what fails until both pass.
If a test looks wrong, or the slice can't be done inside the Boundary, stop and report it; don't work around it.
Don't commit, push or run git that writes. Don't start dev servers or leave processes running.
Report: files changed with one line each on why, the test and verify commands with their last lines of output, anything you stopped on, and anything you noticed outside the Boundary.
```

For a fix round (a failed acceptance, a confirmed review Blocker), send the same brief plus the finding with its evidence and the expected behavior, as a new round.

### Test author brief

Give only what the tests need, never how you plan to implement:

```text
You are the test author for slice <n> of ticket <TNN> in /data/worktrees/pdf-generator/<wt>.
Read AGENTS.md first. Write tests only: no production code.

Why: <the plan's Why, 2-4 lines>
Slice outcome: <Outcome>
Acceptance: <Acceptance, verbatim from the plan>
Public interface: <function signatures, HTTP routes, CLI, file formats the tests may use; existing modules they may import>
Fixtures available: <paths>; contract schemas: <paths>
Existing test setup: <runner, config, example test file>

Write tests outside-in: the first test sits at the level of Acceptance (route, CLI, end-to-end) where the test environment can reach it; add narrower tests only where they pin a behavior the outer test can't. Use the necessity rules in ~/.claude/skills/tdd/test-judgment.md: each test names the regression it catches; no tests that restate declarations.
Run them through `T3CODE_WORKTREE_PATH=/data/worktrees/pdf-generator/<wt> wt-exec <test command>` and confirm every one fails for the expected reason (missing behavior, not a syntax, import or setup error). If a test pins behavior that already exists (so it can't run RED), show it can fail with a temporary break of the production code, then revert the break and report both runs.
You own every test the slice's behavior changes, not just new ones: search the package for existing tests of the modules the slice touches (`grep -rn <module> --include=*.test.ts`) and update their expectations now; the implementer may not touch any test, so a stale one costs a whole round. Test doubles must match the real types (for example, a mocked checker returns the real report type).
Before you report, run the package typecheck (`pnpm --filter <package> typecheck`) and format your test files with the repo formatter (`T3CODE_WORKTREE_PATH=… wt-exec pnpm exec biome check --write <your files>`) and make sure `pnpm lint` passes on them: the implementer may not touch your tests, so a lint-only failure costs a whole extra round.
A `.ts` file that `node` runs directly (scripts, `node --test`) must use erasable TypeScript only: no parameter properties, enums or namespaces, which Node's type stripping rejects.
Don't commit. Don't edit files outside the test directories and fixtures you create.
Report: the files you wrote, each test's name and the regression it catches, the exact RED command and its relevant output.
```

### Review lens brief

A Security brief can be refused by a provider's cybersecurity filter (OpenAI's refused one). Frame it around the project goal (print parity: a pack must print the same way every time and fetch nothing; reproducibility), not around attacking; that framing went through. A refusal is a provider failure: retry once reworded, then fall back.

One child per lens, run in parallel. Take the lens definitions from `~/.claude/skills/review-change/lenses.md` and the rating rules from `~/.claude/skills/review-change/SKILL.md` ("Rate Blocker or Hardening").

```text
Review a change in /data/worktrees/pdf-generator/<wt> through the <lens> lens only.
Read AGENTS.md first, then the lens definition and rating rules:
- ~/.claude/skills/review-change/lenses.md, section "<lens>"
- ~/.claude/skills/review-change/SKILL.md, section "6. Rate Blocker or Hardening"
Scope: `git -C /data/worktrees/pdf-generator/<wt> diff <base>..HEAD` (plus the working tree if uncommitted).
Ticket: <paste the ticket section from docs/tickets.md>
Plan: <the accepted plan, or the slice's Outcome/Acceptance/Boundary>
Validation already run: <commands and results>
<For Test Quality: RED evidence: the test author's RED command and output.>

You are read-only: don't edit, commit or run anything that writes outside /tmp. You may run tests and read any file in the worktree.
Report findings inside your lens only, each with file and line, the concrete trigger, the evidence the lens requires, and a rating of Blocker or Hardening. Mark anything you could not back with that evidence as unconfirmed. Don't summarize the change.
```

## After the child reports

- Its claims are leads, not facts (`verification-evidence`). Rerun a test author's RED command yourself before the implementer starts; after an implementer, read `git -C <path> diff --stat`, then the diff, and rerun the slice's tests yourself; and confirm a reported Blocker yourself before acting on it, as `review-change` step 5 requires.
- **Test ownership.** You don't edit a delegated test, not even to fix an import. If you believe one is wrong, start a new round with the same target: the original brief, the test, your objection with evidence, and ask the author to fix it or defend it. If you still disagree after that round, send the dispute to the coordinator; don't settle it yourself.
- **Review rounds.** After fixing Blockers, start a new round for each lens that had them: the original brief, the earlier findings, your fix, and any finding you dispute with your evidence. Stop once a round reports no Blockers.
