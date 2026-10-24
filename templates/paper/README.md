# 學術論文 (paper)

The T25 template pack: a LaTeX-style journal paper for OCR and layout models. The pack itself is in `pack/` (the zip root you upload); this folder is the workspace package `@pdf-generator/paper` that builds, tests and accepts it. It follows the [incident form](../incident-form/README.md)'s layout.

## What it shows

| Feature | Where | In gt.json |
| --- | --- | --- |
| Title block across the page | title with a `†` call, 2–4 authors with affiliations (the first with `*`), 摘要 + 關鍵詞, English Abstract (`lang="en"`) | `title`, `paragraph`, `heading`, `label`, `field` |
| Two columns | `.columns` (`column-count: 2`), sections 1–5 with 3.1 / 3.2 | blocks in the left column come before the right one on each page |
| Display formulas | four numbered equations (`\tag{1}`…`\tag{4}`), each chosen from 3 options per record (`eq1`…`eq4`) | `formula` with `latex` = the LaTeX source, `text` = KaTeX's visible rendering |
| Footnotes | first page only, in the bottom margin: dates, `*` corresponding author, `†` grant, `1` (called at the end of the first intro paragraph) | four `footnote` blocks on page 1 |
| References | 5–8 entries, numbered `[1]`…, Chinese or English style per entry, an optional second Chinese author | `reference` |
| Running header | journal, volume, issue, year on every page | `page_header` per page |

The paper runs 2–3 pages. There are no page numbers because the page count depends on the record.

## How the formulas get into the pack

No script runs at print time, so KaTeX's output is pre-rendered. `src/formulas.ts` holds the LaTeX pool. `src/paper.hbs` is the template source, where a `<!-- formula eqN -->` line marks each equation. `src/build.ts` writes:

- `pack/templates/paper.hbs`: the source with each marker replaced by one `{{#if (eq @root.eqN k)}}` branch per option. Each branch is a `data-gt="formula"` block whose `data-gt-latex` holds the LaTeX (braces as `&#123;`/`&#125;`, so Handlebars leaves them alone), with KaTeX's display-mode HTML inside (no MathML).
- `pack/styles/katex.css`: KaTeX 0.16's stylesheet as it ships, with `@font-face` only for the faces the pool prints. The platform handles KaTeX's paint order and its `.vlist-s` U+200B itself (T14-3), so the pack needs no fixes of its own.
- `pack/fonts/KaTeX_*.woff2`: the `katex` package's woff2 files, unchanged.

After changing `formulas.ts`, `paper.hbs` or the KaTeX version, rebuild. `build.test.ts` fails while the committed files are stale:

```bash
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm --filter @pdf-generator/paper build-pack"
```

Edit `pack/styles/paper.css`, `pack/data/` and `pack/manifest.json` directly; they aren't generated. Reference numbers come from an `eq @index` chain written out up to 8, which matches `references.maxItems` in the rules: raise both together.

## Layout rules it relies on

- Paragraphs, formulas and references in `.columns` have `break-inside: avoid`. A block split across two columns gets a single gt box spanning both, which is wrong.
- Every marked block is a block element, except 關鍵詞, whose label is bold with a margin so it can't merge with its value (backlog T14-1).
- Fonts are the platform's Noto Serif TC plus the pack's KaTeX faces. Text is single-number citations (`文獻 [n]`), ASCII hyphens in page ranges, and no full-width ／ (T07-13).

## Tests

```bash
T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc "pnpm exec vitest run --project @pdf-generator/paper"
```

- `build.test.ts`: the generated files are current, every formula option fills with its exact LaTeX, the shipped faces cover what KaTeX prints, the stylesheet is KaTeX's own (no pack overrides), and the size budget.
- `pack.test.ts`: `checkPack` on the pack and on 100 generated records, reading order of every block, reference numbering and language branches, footnotes, and the 64 KiB template limit.
- `compare.test.ts`: the acceptance's per-fixture check, against a real printed fixture (`src/fixtures/`) and mutations of it.

## Acceptance

With the print and web dev servers running (`AGENTS.md`, "Batch locally") and the local D1 migrated:

```bash
flock /tmp/pdf-generator-heavy.lock env T3CODE_WORKTREE_PATH=<worktree> wt-exec bash -lc \
  "pnpm --filter @pdf-generator/paper acceptance --url https://app-<wt>.pdf-generator.liaoann.net --count 10"
```

The script uploads `pack/` as a new version, prints a batch and prints one line per fixture. It exits 0 only when every fixture completed and passed self-check, and every gt.json matches its data.json (`src/compare.ts`):

- each formula's LaTeX;
- the reference count and numbering;
- the four first-page footnotes below the body;
- a header on every page;
- no block wider than a column, with the left column read before the right.

It also lists which of the 12 formula options were printed.
