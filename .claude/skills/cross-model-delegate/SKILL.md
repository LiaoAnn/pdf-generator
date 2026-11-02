---
name: cross-model-delegate
description: Use when handing a slice's implementation or a review lens to a different model than the one that wrote the tests, including fallback when that model's credit runs out.
---

# Cross-Model Delegate

You (the worker, Opus 5.5 high) run the flow and write the tests; Kimi K3 implements each slice and runs the long jobs (probes, `pnpm verify`, acceptance batches, re-checks after a rebase, the PR draft), so your own conversation stays short; GPT-6.1-Sol reviews the whole ticket. Three models, so a misunderstanding in one isn't copied into the others' checks (set by the user 2026-11-02; before that Opus implemented and Codex wrote the tests). This skill says which model, how to call it, what the brief holds, the rules for your tests, and what to do when a call fails.

## Targets

Call T3's `delegate_task` (it may appear as `mcp__t3-code__delegate_task`). Don't use the native `Agent`/`Task` tool for these roles: it can only run Claude models.

| Role | Primary `target` | Fallback |
| --- | --- | --- |
| Implementer and runner (`role: "implementation"`, `"research"` for a probe) | `{"providerInstanceId": "pi", "model": "litellm/Kimi-K3-NVFP4", "options": {"thinking": "high"}}` | You implement the slice yourself and record it in the slice report and the PR. |
| Review lens (`role: "review"`) | `{"providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": {"reasoningEffort": "medium"}}` | `{"providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": {"effort": "medium"}}`, a fresh Opus with only the brief |

Before the first call in a thread, run `orchestrator_capabilities` once (with `search: "kimi"` too, to list pi's model) and check every model above is listed. If an ID changed, use the closest listed equivalent and say so in your report.

Common settings:
- `isolation`: leave unset (shared). The child works in your worktree and sees your files.
- `mode`: always `"async"`, then end your turn. Don't use `"wait"`: while you wait you can't take messages, so a child that asks you a question waits on you while you wait on it (T05-2, 2026-10-26). The child's completion or question wakes your thread in a new turn: answer a question with `t3_pending_request_respond` (the thread and request ids are in the notice), or relay it to the coordinator when the ticket and plan don't settle it. Keep each `taskId`; on waking, `task_status` tells you which children are done. If you are woken with nothing from a child, check `task_status` before starting a duplicate.
- `clientRequestId`: `<ticket>-<slice>-<role>-r<round>`, for example `T05-s2-impl-r1` or `T05-final-correctness-r1`. Keep it stable across retries of the same round; a new round gets a new number.
- `title`: the same string as `clientRequestId`.
- Only one implementer at a time in your worktree, and don't edit production files while it runs: you would overwrite each other.

### When to fall back

Fall back, with the same brief and a new `clientRequestId` ending in `-fb`, when the primary call or its task:
- fails with a quota, credit, usage-limit, rate-limit (after one retry 2 minutes later), authentication or "provider unavailable" error; or
- fails twice in a row for any other reason.

A transport error `read-process-exit-status` means T3's shared process for that provider has died (on 2026-10-24 the kernel's OOM killer killed Codex's), and it stays down until the user restarts it in T3. Fall back at once without retrying, for the rest of the ticket, and tell the coordinator in your next message.

Once the primary has hit a credit or quota limit, use the fallback for the rest of the ticket; don't probe the primary again. Record every fallback (which call, the error text) in your slice report and the PR. If a fallback fails too, stop and report to the coordinator.

The Opus review fallback runs on the same Claude account as you: when you yourself hit the Claude usage limit, it is unavailable too. A fallback that failed for that reason is not a failure of the primary; retry the primary first once the limit resets.

When you implemented a slice yourself (Kimi fallback) and Codex is also unavailable, the Opus reviewer shares your model: say so in the PR so the coordinator can name it in the merge note.

## Writing the tests (you)

You are the test author. Run `/tdd` for the cycle and follow its test judgment, plus these rules (each one came from a past failure):

- Write tests outside-in: the first test sits at the level of Acceptance (route, CLI, end-to-end) where the test environment can reach it; add narrower tests only where they pin a behavior the outer test can't. Use the necessity rules in `~/.claude/skills/tdd/test-judgment.md`: each test names the regression it catches; no tests that restate declarations.
- Test only the public interface the plan names; don't write tests that dictate an internal structure the implementer must guess.
- Run them through `T3CODE_WORKTREE_PATH=<path> wt-exec <test command>` (`wt-exec --heavy …` for browser tests or a whole package's suite) and confirm every one fails for the expected reason (missing behavior, not a syntax, import or setup error). If a test pins behavior that already exists (so it can't run RED), show it can fail with a temporary break of the production code in a copy outside the worktree, then report both runs.
- When a slice changes a module's wire calls (a new request to the print Worker, say), also search for tests that fake that service (`grep -rn "print.internal\|PRINT:" --include=*.test.ts`), not only the module's own tests: T07-5 missed three queue tests that way.
- You own every test the slice's behavior changes, not just new ones: search the package for existing tests of the modules the slice touches (`grep -rn <module> --include=*.test.ts`) and update their expectations now. Test doubles must match the real types (for example, a mocked checker returns the real report type).
- Before handing off, run the package typecheck (`pnpm --filter <package> typecheck`), format the test files (`T3CODE_WORKTREE_PATH=<path> wt-exec pnpm exec biome check --write <your files>`) and make sure `pnpm lint` passes on them.
- A `.ts` file that `node` runs directly (scripts, `node --test`) must use erasable TypeScript only: no parameter properties, enums or namespaces, which Node's type stripping rejects.
- Don't `toEqual` multi-MB buffers (fonts, PDFs): Vitest's diff of a failing comparison ran out of heap (T07-13). Compare a hash, the length or the bytes you care about.
- A timing test compares against a baseline timed in the same run (for example a frozen reference implementation on the same input, interleaved), never a fixed bound in ms: GitHub runners and the shared VM swing about 2× between runs, and T15-4's 300 ms bound turned `main`'s CI red (T15-5).
- In a print fixture, a style override in a `data-pagedjs-ignore` sheet loses to the pack's own rule of equal specificity: Paged.js re-inserts the pack's processed `<style>` sheets after the ignored ones. Raise the override's specificity (a class, or `!important`) and check that it took effect, or the test passes for the wrong reason (T07-22).
- Paged.js applies `break-before`/`break-after` only from stylesheet rules, not from a `style` attribute: put a fixture's page breaks in its `<style>` and check the element really lands on the page you meant (T07-30's page-2 case stayed on page 1).
- Watch a new or changed fixture's effect on tests that copy it: a test that copied a fixture's font 65,540 times needed ≈12 GB once the font was real (T06-1).

Don't commit red tests (`AGENTS.md`): the slice's commit holds its tests and its implementation together.

## Implementer brief (Kimi K3)

The child starts with no history and doesn't see your conversation or skills. pi loads `~/.config/devvm/AGENTS.md` on its own; tell it to read the repo's `AGENTS.md`. Write a self-contained brief:

```text
You are the implementer for slice <n> of ticket <TNN> in /data/worktrees/pdf-generator/<wt> (worktree name <wt>).
Read AGENTS.md in that folder first; ~/.config/devvm/AGENTS.md (already loaded) says how to run things on this VM.

Why: <the plan's Why, 2-4 lines>
Slice outcome: <Outcome>
Boundary: <files and modules you may change; anything else is out of bounds>
Approach: <the plan's How for this slice: the design decisions already made, interfaces to keep, stubs>
Ticket's out of scope (不做): <verbatim>
Tests that define done: <test files>. RED now: `<command>` → <relevant output, a few lines>

Make these tests pass with the smallest change inside the Boundary. Don't edit, delete, skip or weaken any test or fixture. If you think a test is wrong, stop and report why with evidence; don't work around it.
Run every project command in the stack: `T3CODE_WORKTREE_PATH=/data/worktrees/pdf-generator/<wt> wt-exec <cmd…>`. A whole package's suite or a browser test takes the heavy lock: `wt-exec --heavy …`, or for anything over about 2 minutes `wt-bg /data/worktrees/pdf-generator/<wt> <name> --heavy --timeout 20m -- <cmd…>` and `wt-wait /data/worktrees/pdf-generator/<wt> <name> --max 110` until it exits 0. Steps with `cd`, pipes, `rm` or quotes go in a script file under /tmp/<wt>/ run with `wt-bg … --script <file>`, never inside a `bash -c "…"` string.
Determinism (AGENTS.md "Quality bar"): no unseeded randomness, wall-clock time or uncontrolled iteration order in the generation path.
Don't: commit or run any git command that writes (read-only `git -C /data/worktrees/pdf-generator/<wt> diff` / `status` is fine); install, upgrade or relink packages unless the Approach says so; touch the shared contract, docs/tickets.md, AGENTS.md or .claude/; call any real external service (Cloudflare account, `--remote`, deploys); `pkill`/`kill` by name in the container; leave a dev server or tmux session running.
Before you report, run the package typecheck and `T3CODE_WORKTREE_PATH=… wt-exec pnpm exec biome check --write <files you changed>`, then the full `pnpm verify`: `wt-bg /data/worktrees/pdf-generator/<wt> verify --heavy --timeout 20m -- pnpm verify` and `wt-wait … verify --max 110` until it exits 0.
Report: the files you changed and why each, the test command and the tail of its output, typecheck and lint results, the `pnpm verify` exit line and its log path (~/.local/state/wt/jobs/<wt>/verify.log), and anything you couldn't do or suspect is wrong.
```

## Runner brief (Kimi K3: probes, acceptance runs, re-checks, PR draft)

Hand Kimi any job that is long or mostly waiting: a probe of how Chrome or pdf.js behaves, an acceptance batch, the 6-template gt.json comparison against a main baseline, `pnpm verify` after a rebase or a small fix, drafting the PR body. You design the job and its pass criterion; Kimi runs it and reports. One runner or implementer at a time in your worktree unless the jobs can't touch the same files or dev servers.

```text
You are a runner for ticket <TNN> in /data/worktrees/pdf-generator/<wt> (worktree name <wt>).
Read AGENTS.md in that folder first; ~/.config/devvm/AGENTS.md (already loaded) says how to run things on this VM.

Job: <what to run or find out, step by step: commands, inputs, seeds, which templates, the baseline to compare against>
Pass criterion: <what result counts as pass, and what to report if it isn't>
Outputs: put logs and outputs under /tmp/<wt>/<job>/ in the container (or ~/.local/state/wt/jobs/<wt>/ for wt-bg logs), never in the worktree.

Run every project command in the stack (`T3CODE_WORKTREE_PATH=... wt-exec`, heavy ones with `wt-bg ... --heavy` and `wt-wait ... --max 110` until it exits 0). Steps with `cd`, pipes, `rm` or quotes go in a script file under /tmp/<wt>/, run with `wt-bg ... --script <file>` (it drops the file's extension: a Node .mjs script must be written and run by a bash script). Start dev servers only if the job needs them, as `tmux new -d -s <wt>-<role> -- env T3CODE_WORKTREE_PATH=... wt-exec <cmd...>`, and stop them with `tmux kill-session` before you report.
Don't change any file in the worktree (a probe may use scratch files under /tmp only); don't commit or run git commands that write; don't call any real external service; don't kill processes by name.
Report, short: each command you ran and its exit code, the numbers the pass criterion asks for, PASS or FAIL against it, and the path of every log and output file. Quote at most a few lines of output; I will read the files.
```

For a PR draft, the job is "write /tmp/<wt>/pr-body.md from these slice reports and evidence paths, in the PR format below", with the format pasted from `work-ticket` step 4.4.

## After the implementer reports

- Its claims are leads, not facts (`verification-evidence`). Read its diff (`git diff --stat`, then the diff), check it stayed in the Boundary and didn't touch a test, rerun the slice's tests yourself (short), and read the tail of its `pnpm verify` log. A runner's report gets the same treatment: open the files it names and check the numbers that decide pass or fail.
- **Fixes.** A failing test, an out-of-Boundary change or a design problem goes back to Kimi in a new round: the original brief, what it changed, the problem with evidence. You may fix it yourself only when the fix is small (about 10 lines of production code or less: lint, a typo, a missed case a test already pins); list every such fix (file, what, why) in the slice report and the PR.
- **Test objections.** You own the tests. When Kimi says a test is wrong, check its evidence: fix the test (note it in the slice report) or keep it and tell Kimi why in the next round. A dispute that touches the ticket's scope goes to the coordinator as an `ASK`.

## Review lens brief

A Security brief can be refused by a provider's cybersecurity filter (OpenAI's refused one). Frame it around the project goal (print parity: a pack must print the same way every time and fetch nothing; reproducibility), not around attacking; that framing went through. Name earlier findings by what they do, not as attacks: a round-2 brief citing the round-1 "decoy … bypass" was refused, and "which pack CSS still places page boxes differently between the screen measurement and the print" went through (T07-18). Likewise "Questions for this lens: which pack CSS … can still make the ground truth's boxes differ" was refused, and "for print parity and reproducibility, using the Security lens definition as your checklist" went through (T07-20). A refusal is a provider failure: retry once reworded, then fall back. Word an implementer brief for hostile-pack cases the same way, as print-parity cases a pack must not get past (T07-29's brief with attack wording was refused).

One child per lens, run in parallel. Take the lens definitions from `~/.claude/skills/review-change/lenses.md` and the rating rules from `~/.claude/skills/review-change/SKILL.md` ("Rate Blocker or Hardening"). Tell the Opus fallback to read `AGENTS.md` first; Codex does so on its own.

```text
Review a change in /data/worktrees/pdf-generator/<wt> through the <lens> lens only.
Read AGENTS.md first, then the lens definition and rating rules:
- ~/.claude/skills/review-change/lenses.md, section "<lens>"
- ~/.claude/skills/review-change/SKILL.md, section "6. Rate Blocker or Hardening"
Scope: `git -C /data/worktrees/pdf-generator/<wt> diff <base>..HEAD` (plus the working tree if uncommitted).
Ticket: <paste the ticket section from docs/tickets.md>
Plan: <the accepted plan, or the slice's Outcome/Acceptance/Boundary>
Validation already run: <commands and results>
Who wrote what: tests by Opus 5.5 (the worker), implementation by Kimi K3, small fixes by the worker: <list>.
<For Test Quality: RED evidence: the RED command and output.>

You are read-only: don't edit, commit or run anything that writes outside /tmp. You may run tests and read any file in the worktree.
Report findings inside your lens only, each with file and line, the concrete trigger, the evidence the lens requires, and a rating of Blocker or Hardening. Mark anything you could not back with that evidence as unconfirmed. Don't summarize the change.
```

## After a reviewer reports

- Confirm a reported Blocker yourself before acting on it, as `review-change` step 5 requires.
- Fix confirmed Blockers through Kimi (the "Fixes" rule above, including the small-fix exception), with a test first where the Blocker is a behavior.
- After fixing, start a new round for each lens that had Blockers: the original brief, the earlier findings, your fix, and any finding you dispute with your evidence. Stop once a round reports no Blockers.
