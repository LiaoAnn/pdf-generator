# @pdf-generator/ground-truth

Reads `gt.json` (the shared contract's `gtSchema`) from a page that Paged.js has finished paginating.

## Calling it

```ts
import { readGroundTruth } from '@pdf-generator/ground-truth';

// `page`: a Playwright or @cloudflare/puppeteer Page, after the document's
// PagedConfig.after has run, in the session that prints the PDF (T03 rules 1–3).
const gt = await readGroundTruth(page, { templateId, templateVersion, seed, index });
```

- `page` only needs `evaluate(expression: string)`. The reader sends one self-contained expression and never launches a browser.
- It does not wait for Paged.js. The caller waits for its own `PagedConfig.after` flag. A page with no `.pagedjs_page` throws.
- Problems throw one `GroundTruthError` whose `issues` list every problem: an unknown type, a nested `data-gt`, a missing detail reader, a box outside its page or with zero area, a duplicate id.

## The markup it reads

| Attribute | Meaning |
| --- | --- |
| `data-gt="<type>"` | Marks a block; one of the contract's 17 block types. |
| `data-gt-id="<id>"` | Optional id. Without one, blocks are named `<type>-1`, `<type>-2`, … in reading order. |

- **Box**: the element's border box (padding and border included), relative to its `.pagedjs_page`, CSS px × 0.75 → pt, each edge rounded to 0.01 pt.
- **Page**: the position of its `.pagedjs_page`, from 1. The page size is the one `@page { size }` declares (A4 → 595.28 × 841.89), not the layout box, which Chrome snaps to 1/64 px (595.27 wide). With bleed it falls back to the layout box.
- **Text**: `innerText`, trimmed. CSS-generated content (`::before`, `content: counter(page)`) is not read, so a page number must be real text in the DOM.
- **Hidden elements** (no layout box) are skipped. This includes the original that Paged.js hides for a `position: running()` element.
- **Reading order**: page by page. On each page: top margin boxes, left, content area, right, bottom margin boxes; document order within each.
- **Repeats**: the same element on several pages (running header or footer clones, split fragments) keeps its first id, then `-2`, `-3`, …. A fragment Paged.js split off (`data-split-from`) gets `continues` = the previous fragment's id.
- `data-gt` elements must not nest.

## Tables and special items (T13)

`readGroundTruth` fills the fields the contract requires beyond the common ones with built-in detail readers. `options.detailReaders` replaces them per type; `buildGroundTruth` has none, so there a `table`, `checkbox` or `formula` block without a reader is an error. A reader receives the element's measurement, including `details` collected in the browser, returns the extra fields, and reports a problem by throwing a `GroundTruthError`. The browser half (`collect` in `src/read.ts`) must stay self-contained and declare no named local functions (see its comment). `src/bundled.test.ts` checks that it survives a wrangler-style esbuild bundle.

| Markup | Gives |
| --- | --- |
| `data-gt="table"` on a `<table>` | `table`: the rows printed on that page in visual order (thead, bodies, tfoot), each cell placed by the HTML table algorithm, its rowspan clipped to the printed rows; `header` for a `<th>` or a cell in `<thead>`; cell text and box like a block's. |
| `data-gt="checkbox"` with `data-gt-checked="true\|false"`, or a single `<input type=checkbox\|radio>` (the element or inside it) | `checked`. Both present must agree; neither, or several inputs without the attribute, is an error. |
| `data-gt="formula"` with `data-gt-latex="…"`, or one KaTeX `<annotation encoding="application/x-tex">` inside it | `latex`, trimmed; both present must agree. `text` is the visible `.katex-html` rendering, not KaTeX's hidden MathML copy. |
| `data-gt="image"` with `data-gt-text="…"` | `text`: the text the pack declares for the image (not OCR). An image that declares text and also renders text is an error. |

- **Checkboxes inside table cells** (T02-2) go in the cell's `checkboxes`, in document order: an element inside a cell (not the `<td>`/`<th>` itself) with `data-gt-checked="true|false"`, or a checkbox or radio input outside such an element. `bbox` is that element's own box (mark the box, e.g. `<span data-gt-checked="true">☑</span>是`); `text` is the label: the visible text after it up to the next checkbox or the cell's end, whitespace collapsed. Hidden checkboxes are skipped; a cell without checkboxes has no `checkboxes`.
- **A cell's `text` holds what the PDF text layer holds**: its rendered text, so a mark printed as a glyph (☑, ☐) is part of it, and a native input or a CSS-drawn box adds nothing (checked on a printed PDF with pdf.js: `☑是☐否`, `火災漏水其他 原因`).
- `data-gt-checked`, `data-gt-latex` and `data-gt-text` are allowed only on their type (and `data-gt-checked` inside a table's cells). Any other `data-gt-*` attribute, or any `data-gt-*` attribute on an element inside a block, is an error.
- A blank field needs no attribute: give it a size; its text is `""`.
- **Split tables**: each page's piece is its own block with its own grid (rows from 0) and `continues`. Header rows printed on a later page (by a header-repeat handler; Paged.js 0.4.3 has none) are that piece's header rows.
- **Lost rows**: Paged.js 0.4.3 can leave a row in the content area's hidden overflow, on no page of the PDF (T03 §5). A table cell with more than one client rect or outside its page is an error naming the row. The PDF stays the only authoritative check (T14): T03 saw one lost row these DOM checks miss.

## Tests

The Playwright tests use `playwright-core` (pinned to the container's global Playwright version, whose headless shell is installed in the container and by CI) and `pagedjs` 0.4.3. `fixtures/` holds fixed documents, one per case (T08's two multi-page documents, then T13's checkbox, blank field, formula, image text, table grid, merged cells, cross-page table, repeated header and checkboxes in table cells). Their `gt.json` files were written by hand from the CSS, and each HTML file explains its derivation in a comment. Never regenerate them from the reader's output.
