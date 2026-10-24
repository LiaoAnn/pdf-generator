# 職業災害事故通報單 (incident form)

The T23 template pack: a form-style fixture for OCR and layout models. The pack itself is in `pack/` (the zip root you upload); this folder is the workspace package `@pdf-generator/incident-form` that tests and accepts it.

## What it shows

| Feature | Where | In gt.json |
| --- | --- | --- |
| Large form table, 5 columns | `table.form`, always on page 1 | one `table` block |
| Merged cells | section rows (`colspan="5"`), 事故地點 (`rowspan="2"`) over 地址 / 場所 | `rowSpan` / `colSpan` of the cells |
| Blank fields | 分機, 場所, 目擊者, 目擊者電話, 備註, 簽核日期 (`blankProbability`), 主管簽章 (always empty) | cell `text: ""` |
| Checkboxes | 事故類型, 傷害程度 (one checked), 危害因素, 已採取措施 (any), 是否送醫 (是 / 否 per row) | cell `checkboxes[]` with `checked` and the label |
| Rows that vary | 傷者名單, 1–8 rows; long lists run onto page 2 with the header repeated | `table` block on each page, the second `continues` the first |

How it stays honest:

- Each checkbox is `<span class="box" data-gt-checked="{{…}}">☑ or ☐</span>label`. The attribute and the glyph come from the same field, and the glyph is printed in Noto Sans Symbols 2, so self-check can read the state from the PDF.
- Outside the tables, every marked block is a block element on its own line. No two inline `data-gt` blocks share a line, so the merged-text-item false positive (backlog T14-1) can't happen.
- Fonts are platform fonts only (Noto Sans TC, Noto Sans Symbols 2). There are no images, no pack fonts and no `<link>`: the platform inlines the stylesheet, and pack-own files don't print before T15-2.
- Text lengths are bounded (description ≤ 120, remarks ≤ 60 characters), so the form table never breaks across pages and no merged cell is split.

## Layout for other template tickets

```
templates/<name>/
  package.json      @pdf-generator/<name>: test, typecheck, acceptance scripts
  pack/             manifest.json, templates/*.hbs, styles/*.css, data/rules.json, data/sample.json
  src/*.test.ts     node tests: checkPack, sample and generated records, filled HTML
  src/acceptance.ts upload → batch → self-check and gt.json vs data.json on a running stack
```

## Tests

```bash
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm exec vitest run --project @pdf-generator/incident-form"
```

- `pack.test.ts`: the pack passes `checkPack`, the sample shows every feature, generated records are valid, only printable resources are used.
- `rendered-records.test.ts`: over 100 seeds, row counts, checkboxes and blanks vary, and every filled record sets each `data-gt-checked` and glyph from the data and leaves blanks empty.

## Acceptance

With the print and web dev servers running (`AGENTS.md`, "Batch locally") and the local D1 migrated (`pnpm --filter @pdf-generator/web db:migrate:local`):

```bash
flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc \
  "pnpm --filter @pdf-generator/incident-form acceptance --url https://app-<wt>.pdf-generator.liaoann.net --count 10"
```

It uploads `pack/` as a new version, prints a batch, and prints one line per fixture. It exits 0 only when every fixture completed, passed self-check, and its gt.json has the checkbox states, blank cells and injured notes its data.json asks for.
