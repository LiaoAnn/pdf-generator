# 客戶別銷貨明細表 (financial statement)

The T24 template pack: a financial detail statement for OCR and layout models, on landscape A4, with a header in three levels and one long table that runs across pages. The pack itself is in `pack/` (the zip root you upload); this folder is the workspace package `@pdf-generator/financial-statement` that tests and accepts it. It follows [the pack spec](../../packages/pack-spec/SPEC.md).

## What it shows

| Feature | Where | In gt.json |
| --- | --- | --- |
| Landscape A4 | manifest `page.orientation`, `@page { size: A4 landscape }` | every page wider than tall |
| Page header and footer | `.running-header` / `.running-footer`, Paged.js running elements in `@top-center` / `@bottom-center` | `page_header` and `page_footer` on every page |
| Three-level header | `<thead>` of 3 rows: 本年度 → 上半年 / 下半年 / 全年 → 第一季 … 第四季, 金額, 占比; 客戶名稱 and 統一編號 `rowspan="3"`, 上年度 `colspan="2" rowspan="2"`, 比較 `rowspan="2"` | header cells with `rowSpan` / `colSpan` |
| Table across pages | 4 regions of 2–12 customers each (8–48 rows plus region, subtotal and total rows); the sample (26 customers) fills 3 pages | one `table` block per page, each later one `continues` the one before, and each starts with the whole 3-row header (the platform repeats the `<thead>`) |
| Merged body cells | region rows (`colspan="11"`), 小計 and 總計 labels (`colspan="2"`) | `colSpan` |
| Derived numbers | per customer: 全年 = sum of the quarters, shares of the grand totals, 本年/上年 ratio (row-scoped `sum` / `percentage`); region 小計 and 總計 rows (`sum`) | in the table |
| Signatures | a small second table: 負責人, 經理人, 會計主管, 製表人 | a `table` block |

How it stays honest:

- Fixed column widths (`table-layout: fixed`, 11 `<col>` widths), so every page's fragment has the same columns (T03 §5).
- Outside the tables, every marked block is a block element on its own line, so no two inline `data-gt` blocks share a line (backlog T14-1). The signer names are in a table for the same reason.
- No page number: `counter(page)` text can't carry `data-gt`, and the page count depends on the record (spec §5).
- Fonts are platform fonts only (Noto Sans TC, Noto Serif TC for the title); no images, no pack fonts.
- 本年/上年（%） prints an ASCII `/`. A full-width `／` (U+FF0F) is missing from the PDF text the print guard reads, so every print would fail with `text_missing` (T07-13). Use `／` again once T07-13 merges.
- Customer names come from the engine's `company` pool (768 names), so one statement can list the same name twice. Each still has its own 統一編號.

## Tests

```bash
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm exec vitest run --project @pdf-generator/financial-statement"
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm --filter @pdf-generator/financial-statement check-pack"
```

- `data.test.ts`: the manifest is landscape A4; the rules and sample are valid; over 100 seeds, records are reproducible, customer counts vary, and every subtotal, total, share and ratio equals what its parts say.
- `pack.test.ts`: the pack passes `checkPack`; the sample and 50 generated records fill into the 3-row header with its spans, every region, customer, subtotal and total row in order with grouped amounts and two-decimal percentages, and the signature table; the CSS is landscape, fixed-layout, with running elements in the margin boxes and no generated text or custom fonts.

## Acceptance

With the print and web dev servers running (`AGENTS.md`, "Batch locally") and the local D1 migrated (`pnpm --filter @pdf-generator/web db:migrate:local`):

```bash
flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc \
  "pnpm --filter @pdf-generator/financial-statement acceptance --url https://app-<wt>.pdf-generator.liaoann.net --count 10"
```

It uploads `pack/` as a new version, prints a batch and prints one line per fixture. It exits 0 only when:

- every fixture completed and passed self-check;
- its pages are landscape, with the header and footer on every page;
- every fragment of the statement table, on consecutive pages, starts with exactly the three header rows;
- every later fragment's columns have the first page's x ranges, within 1 pt (T07-14);
- the body rows across the fragments and the signer row are the ones its data.json asks for;
- at least one fixture's table ran across pages.

After a run, stop the dev servers with the stop recipe in `AGENTS.md` ("Commands").
