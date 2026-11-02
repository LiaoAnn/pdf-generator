# @pdf-generator/dev-tools

Tools for working on the platform and on template packs. Nothing in the product imports this package.

## pdf-to-png

The T3 preview browser downloads a PDF instead of showing it. `pdf-to-png` draws each page as a PNG with pdf.js (unpdf's build, the one `packages/self-check` reads PDFs with) in the container's Playwright Chromium, and can draw a gt.json's boxes over the pages, so you can see whether the ground truth sits on what was printed. Run it in your stack, from the repo root:

```bash
pnpm pdf-to-png <pdf> [--gt <gt.json>] [--out <dir>] [--scale <n>]
# the same: node packages/dev-tools/src/cli.ts <pdf> …
```

- Writes `<dir>/<name>-p<N>.png` for page N (from 1) and prints each path. `--out` defaults to the PDF's folder: keep output outside the worktree (the container's `/tmp`) or under `.wrangler/`, since Biome lints every other file in it.
- `--scale` is pixels per PDF point (default 2; A4 is then about 1190 × 1684 px).
- `--gt` validates the file with the contract's `gtSchema`, then draws on page N every block with `page` N: its bbox outlined in a colour per block type, with its `order` and `id` above it (inside the box when it starts at the top of the page). Table cells are outlined in orange and cell checkboxes in cyan. The outlines are 2 px wide, the pixel before and the one at each edge. Boxes are placed at gt.json's points × scale, without correcting for the PDF's MediaBox being slightly off the declared page size (Chrome prints A4 as 594.96 × 841.92 pt).

To look at the PNGs, read them with an agent's image reader (Claude Code's Read tool shows images). From code:

```ts
import { pdfToPng } from '@pdf-generator/dev-tools';

const pngs = await pdfToPng(pdfBytes, { scale: 2, gt }); // one PNG's bytes per page
```

PDFs that rely on fonts they don't embed (the platform's prints embed theirs) may render with substitute glyphs: pdf.js gets no standard fonts or CMaps here.

## dump-gt and compare-gt

A ticket that changes print or ground-truth shows that every template's gt.json is still the same as on `main` (or lists what changed). `dump-gt` saves a batch's gt.json and self-check results from your local stack; `compare-gt` compares two dumps.

Both need the local batch setup from `AGENTS.md` ("Batch locally"): the print and web dev servers running, `db:migrate:local` done. Run them in your stack, from the repo root, with output outside the worktree (the container's `/tmp`):

```bash
pnpm dump-gt --out /tmp/gt-main [--url <origin>] [--seed <s>] [--count <n>] [--poll-ms <ms>] [<pack dir>…]
pnpm compare-gt /tmp/gt-main /tmp/gt-branch
```

### dump-gt

- Uploads each pack folder (default: every `templates/*/pack`, in name order) through `POST /api/templates`, runs one batch per pack (`--seed`, default `dump-gt`; `--count`, default 10) and waits for it, polling every `--poll-ms` (default 2000) for up to 15 minutes. It uses only the public API routes, with the local Access stand-in's service token.
- `--url` defaults to `http://127.0.0.1:8787` (the web dev server, seen from inside the stack). Only local origins are accepted: `localhost`, `127.0.0.0/8`, `[::1]`, or a worktree URL `<route>-<wt>.<vm>.liaoann.net`. Anything else is refused before any request, since a real Cloudflare account needs the user's OK each time.
- `--out` must be missing or empty, so a dump never mixes with stale files.
- Writes `<out>/<templateId>/<NNNN>/gt.json` and `check.json` for every completed fixture, and `<out>/summary.json` (seed, count, and each fixture's status, error and self-check from the batch's fixture list). gt.json loses `source.templateVersion`, which every re-upload bumps. All JSON is written with keys sorted, 2-space indented, with a trailing newline, and no batch ids, versions, URLs or times. Two dumps of the same code are therefore byte-identical (`diff -r` works too).
- The output folder is named after the template id the upload returned. A modified copy of a pack (kept outside the worktree) therefore lands where the original would and compares against it.
- Prints one line per template and a total, `total: <completed>/<n> completed, self-check <passed>/<n>`. Exit 0 when every fixture completed and passed its self-check, 1 otherwise (the files are still written) or when a request fails, 2 for usage errors and refusals.

### compare-gt

- Refuses (exit 2) a folder that is missing or has no `summary.json`, so a baseline that vanished is caught rather than compared as empty.
- Matches fixtures by `<template>/<NNNN>` and blocks by `id`. gt.json is compared as JSON (key order and `source.templateVersion` ignored), and check.json likewise.
- For each fixture that differs it prints `<template>/<NNNN>: changed`, `only in a` or `only in b`, then one line per difference, with old and new values as JSON:

  ```text
  minimal-example/0001: changed
    pages: [...] → [...]
    title-1: bbox [89.85,84,505.41,107.25] → [95.85,84,511.41,107.25]
    paragraph-1: text "舊" → "新"
    note-1: removed paragraph page 1 bbox [...] text "..."
    table-1: table.rows 2 → 3
    table-1 cell r1c1: bbox [...] → [...]
    table-1 cell r2c0: added bbox [...] text "合計"
    heading-9: added heading page 2 bbox [...] text "..."
    self-check: ok true → false, differences 0 → 2
  ```

  Block fields come in the order type, page, bbox, text, order, continues, checked, latex; cell fields bbox, text, rowSpan, colSpan, header, checkboxes. A different `seed` or `count` in the summaries is reported first.
- Always ends with the counts:

  ```text
  fixtures: 60/60 identical, 0 changed, 0 only in a, 0 only in b
  blocks: 0 changed, 0 added, 0 removed, of 1461 in a
  self-check: a 60/60 passed, b 60/60 passed
  ```

- Exit 0 when nothing differs, 1 when anything does, 2 for usage and input errors.

For a print or ground-truth ticket: with a clean tree, `git -C <path> switch --detach origin/main` on the VM, restart both dev servers and `dump-gt --out /tmp/gt-main`; switch back to your branch, restart them and `dump-gt --out /tmp/gt-branch`; then `compare-gt /tmp/gt-main /tmp/gt-branch`. Take the main dump right before the branch run, so both see the same stack.
