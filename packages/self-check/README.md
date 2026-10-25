# @pdf-generator/self-check

Checks a printed PDF against its `gt.json` (T14) and reports every difference. It reads only the PDF's text layer (pdf.js through `unpdf`) and uses no DOM, browser or Node API, so the same call runs in a Worker and in Node.

## Calling it

```ts
import { checkPdf } from '@pdf-generator/self-check';

// pdf: the bytes /print returned; gt: the gt.json read on the same tab;
// fonts: PostScript names of the fonts the pack may use (optional).
const report = await checkPdf(pdf, gt, { fonts: ['NotoSansTC-Regular', 'NotoSansSymbols2-Regular'] });
if (!report.ok) for (const difference of report.differences) console.log(difference.message);
```

`report.differences` is a list of `Difference`s (see `src/check.ts`): each has a `kind`, the page, the block id where there is one, what gt.json says and what the PDF has, and a `message` for people. The list is deterministic: page count and sizes first, then page by page the blocks' differences in reading order, then text outside every block, then fonts.

The package also exports `readPdf` (each page's MediaBox and text items with positions and font names, and the direction of rotated text) and `missingText`, the print Worker's check that every `data-gt` text is in the PDF (T03 Must 4), which moved here from `apps/print`. The print runtime reports each `data-gt` element's box (its border box and its visible text) with its texts, and `missingText` looks for them only in the PDF items whose anchor height (as below) lies in that box and whose x range overlaps it, both give or take 1 pt (an untagged print holds adjacent same-font spans as one item, which counts for each block it crosses), longest text first, so a formula's single letters can't use up another block's letters (T07-6).

## How it compares

- **Which block a text item belongs to.** The item's anchor is its horizontal centre, 0.35 em above its baseline (T03 §1). It belongs to the block on its page whose box contains the anchor. If several boxes do, a block whose text contains the item's text wins, then the smallest box. In a table, items go to cells the same way.
- **Text.** A block's PDF text is its items in content-stream order. It is compared with gt.json in NFKC, without whitespace and in lower case. U+2015 counts as U+2014, and U+0000 as `——` (Chrome's text layer for Noto's `——` ligature, T03 §2.5). A formula's text also matches when the visible text comes after KaTeX's MathML copy (PR #10), or when its items, each used once and whole, spell it in any order (T14-3). That search has a fixed work budget (`coverBudget`, far above what the paper's formulas need); a formula it can't decide within the budget is a `formula_undecided` difference, never a pass (T14-5). Tables are compared cell by cell, and cell checkbox labels after their mark. Whitespace never counts: a `white-space: pre` run in a cell can be a line break in the PDF.
- **Box.** Each item's ink box is its x range, and vertically the span from its baseline to 0.7 em above it. Rotated text (an item with `dir`) runs along that direction from its origin, and its ink box is the bounds of that rotated span; its anchor turns with it. It must lie inside its block's box, give or take 1 pt. If a block's text is missing from its box but appears among the unclaimed text on its page, that is one `bbox` difference. If it appears on another page, that is one `page` difference.
- **Text outside every block** is `unmarked_text`, one per run of consecutive items. It catches a block missing from gt.json and CSS-generated content (`content: counter(page)`), which gt.json can't hold.
- **Order.** The blocks a page shows must hold the next run of orders. For example, page 2 holds the orders right after those of page 1.
- **Checkboxes.** A `checkbox` block's first ☑ ☒ ✓ ✔ ✅ / ☐ □ glyph gives the printed state. In a table cell, the mark glyph starting inside that checkbox's box gives it.
- **Fonts** (with `fonts`). Each embedded font's name has its subset tag (`ABCDEF+`) removed. Any font not in the list is a `font` difference, with the text printed in it: a glyph fell back to a system font (T03 Must 6).

Tolerances are the constants at the top of `src/check.ts`, each with where its number comes from. The page size tolerance is 1 pt, because Chrome prints A4 as 594.96 × 841.92 pt while gt.json declares 595.28 × 841.89 (PR #7).

## What the PDF can and can't show

| gt.json error | Caught? |
| --- | --- |
| Wrong text, or a wrong table cell | Yes: `text`, `cell_text` |
| A row the PDF lacks (Paged.js's lost row, T03 §5) | Yes: a `cell_text` with empty `actual` for each non-empty cell of that row |
| Box moved | Yes, once its text sticks out by more than 1 pt (horizontally where the text reaches the box's edge; vertically once the baseline or glyph body leaves it) or leaves the box altogether: `bbox` |
| Box too large on a side its text doesn't reach | No: the text layer has no layout box |
| Wrong page | Yes, when the block has text: `page` |
| Block missing from gt.json | Yes, when it has text: `unmarked_text` |
| Extra block with text | Yes: `text` with empty `actual` |
| Extra or wrong blank field (empty text) | No |
| Reading order across pages | Yes: `order` |
| Reading order within a page | No: the content stream follows paint order (Paged.js's margin boxes are painted before the content), not reading order |
| Checkbox state printed as a ☑/☐ glyph | Yes: `checkbox` |
| Checkbox state of a native `<input>` or a CSS-drawn box | No: those are vector graphics, not text |
| Formula LaTeX | No: only the rendered text is compared |
| An image's text (`data-gt-text`) | Only if the image prints it as text. A raster image has no text, so it isn't compared |
| A glyph that fell back to a system font | Yes, with `fonts`: `font` |

## Tests and acceptance

- `pnpm exec vitest run --project @pdf-generator/self-check` prints the ground-truth fixtures and the ones in `fixtures/` with Playwright and Paged.js. It checks the correct gt.json files and deliberately wrong copies, and also checks `readPdf` inside workerd.
- `acceptance/run.ts` prints `acceptance/*.html` through a running print Worker, which reads gt.json on the same tab and embeds the platform fonts. It checks the correct gt.json and each deliberately wrong one against the exact expected differences, and writes the PDFs, gt.json files and reports to `.wrangler/self-check-acceptance`:

  ```bash
  pnpm dev:print --ip 0.0.0.0 --var PRINT_TOKEN:local   # in the stack, with the browser env apps/print's vitest.config.ts sets
  PRINT_TOKEN=local node packages/self-check/acceptance/run.ts
  ```
