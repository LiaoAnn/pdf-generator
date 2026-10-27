#!/usr/bin/env python3
"""PreToolUse guard for Bash: refuse command shapes that stall a worker.

A refused command never runs; the reason goes back to the agent, which
rewrites it. Each rule names the tool to use instead (see work-ticket's
"Don't" and ~/.config/devvm/AGENTS.md).
"""

import json
import re
import sys

# `bash -c "…"`, `bash -lc '…'`, `sh -c …`: the harness can't check the
# string and stops on a permission prompt when it holds rm or eval
# (T07-23, T07-25, T07-2).
SHELL_STRING = re.compile(r"\b(?:ba)?sh\s+-l?c\s+[\"']")
RM_OR_EVAL = re.compile(r"(?:^|[\s;&|(`\"'])(?:rm|eval)\s")
# A full suite in the foreground holds the tool call for 10+ minutes, so
# coordinator messages wait (T05-2).
FOREGROUND_SUITE = re.compile(r"\bpnpm\s+(?:verify|test)(?![\w:-])")
IN_CONTAINER = re.compile(r"\b(?:wt-exec|docker\s+exec)\b")

RULES = (
    (
        lambda c: (m := SHELL_STRING.search(c)) is not None
        and RM_OR_EVAL.search(c, m.end() - 1) is not None,
        "rm or eval inside a bash -c/-lc string stops on a permission prompt. "
        "Write the steps to a script outside the worktree and run it with "
        "`wt-bg <path> <name> --script <file>`.",
    ),
    (
        lambda c: "pdf-generator-heavy.lock" in c,
        "The heavy lock moved into the wt tools: use "
        "`wt-bg <path> <name> --heavy -- <cmd>` or `wt-exec --heavy <cmd>`, "
        "not flock on /tmp/pdf-generator-heavy.lock.",
    ),
    (
        lambda c: IN_CONTAINER.search(c) is not None and re.search(r"\bpkill\b", c) is not None,
        "pkill in the container also kills your delegated children's processes "
        "(test authors' Chrome). Stop a dev server with "
        "`tmux kill-session -t <wt>-<role>`, a job with `wt-stop <path> <name>`.",
    ),
    (
        lambda c: IN_CONTAINER.search(c) is not None
        and FOREGROUND_SUITE.search(c) is not None
        and not c.lstrip().startswith("wt-bg"),
        "A full `pnpm verify`/`pnpm test` in the foreground blocks messages for "
        "its whole run. Start it with `wt-bg <path> <name> --heavy -- pnpm verify` "
        "and poll with `wt-wait <path> <name> --max 110`.",
    ),
)


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    command = (event.get("tool_input") or {}).get("command") or ""
    # Commit messages and PR bodies may quote these shapes.
    if re.match(r"\s*(?:git|gh)\s", command):
        return 0
    for matches, reason in RULES:
        if matches(command):
            print(f"bash-guard: {reason}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
