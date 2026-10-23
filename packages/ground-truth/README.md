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

## Extending it (T13)

`table`, `checkbox` and `formula` need fields the contract requires (`table`, `checked`, `latex`). Pass a detail reader per type in `options.detailReaders`. It receives the element's measurement, including `details` collected in the browser, and returns those fields. Without a reader, such a block is an error. The browser half (`collect` in `src/read.ts`) must stay self-contained and declare no named local functions (see its comment). `src/bundled.test.ts` checks that it survives a wrangler-style esbuild bundle.

## Tests

The Playwright tests use `playwright-core` (pinned to the container's global Playwright version, whose headless shell is installed in the container and by CI) and `pagedjs` 0.4.3. `fixtures/` holds two fixed multi-page documents. Their `gt.json` files were written by hand from the CSS, and each HTML file explains its derivation in a comment. Never regenerate them from the reader's output.
