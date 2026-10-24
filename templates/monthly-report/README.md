# 公司月報 (monthly report)

The T22 template pack: a company monthly report for OCR and layout models, with running text, lists, a figure, tables and a header and footer on every page. The pack itself is in `pack/` (the zip root you upload); this folder is the workspace package `@pdf-generator/monthly-report` that tests and accepts it. It follows [the pack spec](../../packages/pack-spec/SPEC.md).

## What it shows

| Feature | Where | In gt.json |
| --- | --- | --- |
| Page header and footer | `.running-header` / `.running-footer`, Paged.js running elements in `@top-center` / `@bottom-center` | `page_header` and `page_footer` on every page (ids `-2`, `-3`, … on later pages) |
| Title and headings | company and period; 本月摘要, 重點事項, 各部門營運概況, 重點專案進度, 下月工作重點, 備註 | `title`, `heading` |
| Bullet lists | 重點事項 (3–6 items), 下月工作重點 (2–5) | one `list_item` per item |
| Figure with text (圖文) | `assets/figure.svg` beside the figure text, caption below it | `image`, `caption`, `paragraph` |
| Tables | departments (3–7 rows and a 合計 row: sums of the rows, money with thousands separators), projects (2–9 rows) | `table` blocks; a table split across pages continues on the next (`continues`), its header repeated |
| Derived numbers | 合計 row (`sum`), 成本率 (`percentage` of the totals) | in the table and a `paragraph` |
| Blank section | 備註 (`blankProbability` 0.3): heading and paragraph left out when blank | absent |

Most records fill two pages.

How it stays honest:

- Every marked block is a block element on its own line: no two inline `data-gt` blocks share a line, so the merged-text-item false positive (backlog T14-1) can't happen.
- Bullets are drawn (an empty `::before` with a background), so no marker text prints outside a `list_item` box and the item's text is exactly the data.
- The figure and its text sit side by side (flex, not float), so no block's box covers another block's text. The SVG has no `<text>` and loads nothing.
- No page number: `counter(page)` prints text no `data-gt` element holds, and a number written into the DOM can't know how many pages the record fills (spec §5).
- Fonts are platform fonts only (Noto Sans TC, Noto Serif TC for the title), named on the printed elements; no pack fonts.

Known platform issue: the print runtime can choose fonts before the linked stylesheet applies, and then the whole PDF falls back to system fonts and fails self-check (backlog T07-7). Until T07-7 merges, a batch of 10 passes self-check for 7–8 fixtures; the pack doesn't work around it.

## Tests

```bash
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm exec vitest run --project @pdf-generator/monthly-report"
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm --filter @pdf-generator/monthly-report check-pack"
```

`pack.test.ts`: the pack passes `checkPack`; the sample and 50 generated records fill with every block above, list items and table rows matching the data, totals equal to the sums of the rows; the header and footer are running elements in the page margins; no counters, list markers or custom fonts; the SVG has no text or external reference.

## Acceptance

With the print and web dev servers running (`AGENTS.md`, "Batch locally") and the local D1 migrated (`pnpm --filter @pdf-generator/web db:migrate:local`):

```bash
flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc \
  "pnpm --filter @pdf-generator/monthly-report acceptance --url https://app-<wt>.pdf-generator.liaoann.net --count 10"
```

It uploads `pack/` as a new version, prints a batch and prints one line per fixture. It exits 0 only when every fixture completed and passed self-check, and its gt.json has the header and footer on every page and the list items, figure, caption, remarks and table rows (across continued tables) its data.json asks for.

Each batch leaves a local Chrome running (backlog T16-3): after a run, stop the dev servers with the stop recipe in `AGENTS.md` ("Commands"), and start them again for the next one.
