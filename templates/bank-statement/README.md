# 銀行對帳單 (bank statement)

The T26 template pack: a bank's monthly deposit statement, for OCR and layout models. The pack itself is in `pack/` (the zip root you upload); this folder is the workspace package `@pdf-generator/bank-statement` that tests and accepts it.

## What it shows

| Feature | Where | In gt.json |
| --- | --- | --- |
| Logo | `assets/logo.svg`, an `<img>` with no text in it | one `image` block, text empty |
| Barcode | Code 39 of the 10-digit statement number, one inline `<svg>` of bars per character; the number prints below it in HTML | one `barcode` block (text empty), then a `paragraph` `*0123456789*` |
| Customer-service box | `aside.service`, a bordered box of one heading and four paragraphs | `heading` and `paragraph` blocks inside the box |
| Account summary | `table.summary`, label / value pairs | one `table` block |
| Borderless transactions | `table.transactions`, no rules at all; 8–32 rows sorted by date (`sortBy`), balances from `runningBalance`; long statements run onto page 2 with the header repeated | a `table` block per page, the second `continues` the first |
| ROC dates | 交易日期 and 對帳期間 (summary and running header) `format="slash"` (115/09/02: narrow columns, the way banks print them); 製表日期 the default text form (民國115年10月3日). data.json stays ISO | cell text as printed |
| Running header and footer | Paged.js running elements | `page_header`, `page_footer` on every page |

How it stays honest:

- Balances and totals come from the rules (`runningBalance`, `sum`), never typed into the template. The opening balance is at least 32 × the largest withdrawal, so no balance goes negative.
- The barcode really encodes the printed number: each digit picks its fixed Code 39 bar pattern with `{{#if (eq this N)}}`. The bars carry no text (SPEC §4.3), so the barcode block's text is empty and the number is its own block.
- Every marked block outside the tables is a block element on its own line, so no two inline blocks share a line (backlog T14-1).
- Platform fonts only (Noto Sans TC). The notes are numbered `1.`–`3.` rather than marked with `・`: a `・` (U+30FB) in Noto Sans TC doesn't reach the PDF text layer, and the print fails with `text_missing`.
- A row can have both or neither of 支出 and 存入: the rules can't make two fields exclusive. The balance is still exact either way.

## Tests

```bash
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm exec vitest run --project @pdf-generator/bank-statement"
```

- `pack.test.ts`: the pack passes `checkPack`; the sample and 100 generated records are date-sorted with exact, non-negative balances and totals and valid identifiers; row counts and blanks vary; the filled template prints every row, the totals and the closing balance; only pack-local resources.
- `barcode.test.ts`: for the sample and 100 seeds, the barcode's bars decode (Code 39) to the record's statement number and to the number printed under it.

## Acceptance

With the print and web dev servers running (`AGENTS.md`, "Batch locally") and the local D1 migrated (`pnpm --filter @pdf-generator/web db:migrate:local`):

```bash
flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc \
  "pnpm --filter @pdf-generator/bank-statement acceptance --url https://app-<wt>.pdf-generator.liaoann.net --count 10"
```

It uploads `pack/` as a new version, prints a batch, and prints one line per fixture. It exits 0 only when every fixture completed and passed self-check, and its gt.json prints the transactions in date order with every balance equal to the previous balance plus the printed deposit minus the printed withdrawal (from data.json's opening balance, 餘額逐筆對), the amounts data.json holds, the four summary totals, one logo and one barcode on page 1 with the number data.json holds.
