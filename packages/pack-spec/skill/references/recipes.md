# Recipes and print traps

Snippets for the elements most layouts need. Each `pack-ok` block below is run through the checker against the minimal example's data (fields `company`, `meetingDate`, `place`, `chair`, `recorder`, `attendees[]` with `name`/`title`/`present`, `summary`, `items[]`, `confirmed`), so the shapes are known to pass; rename the fields to yours. The full packs in `$PDF_GENERATOR_REPO/templates/` show them in context.

## Title, headings, paragraphs

```html pack-ok
<p class="word-title" data-gt="title">{{company}}業務會議紀錄</p>
<h2 data-gt="heading">一、討論事項</h2>
<p data-gt="paragraph">{{summary}}</p>
```

Fixed headings are numbered in their text (`一、`, `（一）`); there is no counter.

## Label and value pairs

One block for the label (with its `：`), one for the value. Make the label bold: two inline blocks in the same font with no gap between them can come out of Chrome as one PDF text item, which the self-check reports as a mismatch; a different font face (bold) and a margin keep them apart.

```html pack-ok
<p class="pair"><span class="key" data-gt="label">會議日期：</span><span data-gt="field">{{meetingDate}}</span></p>
<p class="pair"><span class="key" data-gt="label">記錄：</span><span class="value" data-gt="field">{{recorder}}</span></p>
```

```css pack-ok
.pair {
  text-align: left;
}

.key {
  font-weight: bold;
  margin-right: 0.5em;
}

/* recorder can be blank: an empty block must still paint something inside its box, or self-check reports ink. */
.value {
  display: inline-block;
  min-width: 6em;
  min-height: 1lh;
  border-bottom: 0.5pt solid #000;
  vertical-align: top;
}
```

Many pairs in a grid (a form header with 2-3 pairs per row): use a `<table data-gt="table">` with the labels and values in cells instead; cells need no marks and a blank cell is fine.

## Lists

```html pack-ok
<ul class="items">
{{#each items}}
<li data-gt="list_item">・{{this}}</li>
{{/each}}
</ul>
```

```css pack-ok
ul.items {
  list-style: none;
  padding-left: 0;
}
```

A fixed numbered list writes its numbers (`1.`, `（一）`) in each item; an array can't number itself.

## Tables

The `<table>` is the block; cells carry no marks. Give every column but one a width.

```html pack-ok
<table data-gt="table">
<colgroup><col class="c-name"><col class="c-title"><col></colgroup>
<thead><tr><th>姓名</th><th>職稱</th><th>備註</th></tr></thead>
<tbody>
{{#each attendees}}
<tr><td>{{name}}</td><td>{{title}}</td><td></td></tr>
{{/each}}
</tbody>
</table>
```

```css pack-ok
col.c-name {
  width: 30%;
}

col.c-title {
  width: 25%;
}
```

- Totals: a `sum` field in the rules (`"of": ["lines[].amount"]`) printed in a last `<tr>` inside `<tbody>` or a `<tfoot>`, with `{{number total}}` for thousands separators.
- Merged cells: plain `colspan`/`rowspan` (see `$PDF_GENERATOR_REPO/templates/incident-form/pack/`).
- A signature or approval area (簽核欄, 核章): a table whose header row has the roles (`承辦`, `主管`, `核准`) and whose body row has empty cells with a fixed height (`td { height: 20mm }`).
- Keep `maxItems` and text lengths small enough that a row never grows taller than a page.

## Checkboxes

A single checkbox, its state from a boolean field:

```html pack-ok
<p data-gt="checkbox" data-gt-checked="{{confirmed}}"><span class="box">{{#if confirmed}}☑{{else}}☐{{/if}}</span>本紀錄已經主席確認無誤。</p>
```

Options inside a table cell (each box marked with `data-gt-checked` only):

```html pack-ok
<table data-gt="table">
<tbody>
{{#each attendees}}
<tr><td>{{name}}</td><td>{{#if present}}<span class="box" data-gt-checked="true">☑</span>出席　<span class="box" data-gt-checked="false">☐</span>缺席{{else}}<span class="box" data-gt-checked="false">☐</span>出席　<span class="box" data-gt-checked="true">☑</span>缺席{{/if}}</td></tr>
{{/each}}
</tbody>
</table>
```

```css pack-ok
.box {
  font-family: "Noto Sans Symbols 2", "Noto Serif TC", serif;
}
```

A choice among several options (`choice` field `status`): one branch per option, `{{#if (eq status "已結案")}}…{{/if}}`, each printing all the boxes with the right one checked.

## Header and footer on every page

Put them first in `<body>`. `word.css` already places `.word-header` in `@top-center` and `.word-footer` in `@bottom-center`:

```html pack-ok
<div class="word-header" data-gt="page_header">{{company}}　內部文件</div>
<div class="word-footer" data-gt="page_footer">本文件內容為測試用假資料。</div>
<p class="word-title" data-gt="title">業務會議紀錄</p>
```

Your own margins and margin boxes: see `$PDF_GENERATOR_REPO/templates/monthly-report/pack/styles/` (`position: running(…)` and `content: element(…)` in `@page`). Page numbers: a running `page_number` block with empty `data-gt-page-number` / `data-gt-page-count` slots, as in that pack (spec §4.4).

## Optional sections

A field with `blankProbability` that drops a whole section: put the heading and the text in the same branch, so a blank record prints neither.

```html pack-ok
{{#if recorder}}
<h2 data-gt="heading">記錄人</h2>
<p data-gt="paragraph">{{recorder}}</p>
{{/if}}
```

## Dates, money, numbers

- `date` fields print `YYYY-MM-DD`. For 民國 dates, keep the `date` field and print it with `rocDate` (SPEC §3): `{{rocDate d}}` → `民國113年5月7日`, `format="slash"` → `113/05/07`, `"chinese"` → `中華民國一一三年五月七日`, `"year"`/`"month"`/`"day"` for separate 年 月 日 boxes.
- Dates that must agree (start ≤ end, rows within a trip): each `date` field is drawn on its own, so give them ranges that can't cross instead of pinning them to one day: start in `2026-03-02`..`2026-03-06`, end in `2026-03-09`..`2026-03-13`, row dates in `2026-03-06`..`2026-03-09`. Rows of an array are not sorted by date.
- Money: `money` with `decimals: 0` and `{{number amount}}`; amounts with cents: `decimals=2`.
- Derived values (`sum`, `percentage`, `runningBalance`) come from the rules, never from the template: there is no arithmetic in templates. `{{number x}}` of a `null` prints nothing.
- A closing balance is the last row's `runningBalance`: `{{#each rows}}{{#if @last}}{{number balance}}{{/if}}{{/each}}` in the closing cell.
- Either-or columns (支出 or 存入): the engine can't make two fields exclusive, nor tie one field's value to another's (a 摘要 that matches the column). Without a running balance, use one `choice` field `kind` and one `money` field, printed in the matching cell with `{{#if (eq kind "支出")}}…{{/if}}`. With a `runningBalance`, which needs separate `add` and `subtract` fields, give both amounts a `blankProbability` (blank counts as 0) and accept that some rows fill both or neither. Keep texts like 摘要 neutral.
- Account numbers and other fixed-length digit strings: an `integer` with `min`/`max` of that many digits (`100000000000`..`999999999999`); print separators by splitting it into several integer fields.

## Two columns

A journal-style body: the title block spans the page, the rest flows in two CSS columns. Put the title block before the column wrapper, and the wrapper itself needs no mark. Blocks in the left column come before the right one in `gt.json` because CSS columns flow in document order, so write the HTML in reading order.

```html pack-ok
<p class="word-title" data-gt="title">{{company}}業務會議紀錄</p>
<main class="columns">
<h2 data-gt="heading">一、討論事項</h2>
<p data-gt="paragraph">{{summary}}</p>
<h2 data-gt="heading">二、決議</h2>
{{#each items}}
<p data-gt="paragraph">{{this}}</p>
{{/each}}
</main>
```

```css pack-ok
.columns {
  column-count: 2;
  column-gap: 7mm;
  column-fill: balance;
}

.columns h2 {
  break-after: avoid;
}

.columns p {
  break-inside: avoid;
}
```

- `column-fill: balance`, never `auto`. With `auto` and `break-inside: avoid`, Paged.js can push the whole column block to the next page, leaving the first page with only the title block.
- `break-inside: avoid` on every block in the columns (paragraphs, formulas, references). A block split across two columns gets a single gt box spanning both, which is wrong. So keep each block shorter than a column: bound `maxLength` in the rules.
- `break-after: avoid` on headings, so a heading isn't left alone at the bottom of a column.
- Running headers and footnotes stay outside the columns, as running elements (above).

See `$PDF_GENERATOR_REPO/templates/paper/pack/styles/paper.css` (`.columns`) in context.

## Formulas (KaTeX)

No script runs at print time, so KaTeX's output goes into the template already rendered. Write a small build script that calls `katex.renderToString(latex, { displayMode: true, output: 'html' })` and pastes the result into a `formula` block whose `data-gt-latex` holds the LaTeX source. `gt.json` takes the LaTeX from that attribute and the block's text from what KaTeX visibly prints. Rerun the script after changing a formula or the KaTeX version.

```html pack-ok
<div class="equation" data-gt="formula" data-gt-latex="E = mc^2"><span class="katex-display"><span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:0.6833em;"></span><span class="mord mathnormal" style="margin-right:0.0576em;">E</span><span class="mspace" style="margin-right:0.2778em;"></span><span class="mrel">=</span><span class="mspace" style="margin-right:0.2778em;"></span></span><span class="base"><span class="strut" style="height:0.8641em;"></span><span class="mord mathnormal">m</span><span class="mord"><span class="mord mathnormal">c</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist" style="height:0.8641em;"><span style="top:-3.113em;margin-right:0.05em;"><span class="pstrut" style="height:2.7em;"></span><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span></span></span></span></span></span></span></span></span></span></div>
```

- **`output: 'html'`**: no MathML. The hidden MathML copy doesn't count toward the block's text, and the LaTeX is already in `data-gt-latex`.
- **Braces**: write every `{` and `}` in the LaTeX and in KaTeX's HTML as `&#123;` and `&#125;`, so Handlebars never sees a `{{` (`\frac{a}{b}` → `data-gt-latex="\frac&#123;a&#125;&#123;b&#125;"`). Escape `&`, `"`, `<` and `>` in the attribute too.
- **A formula chosen per record**: a `choice` field holding the option index, and one `{{#if (eq @root.eq1 0)}}…{{/if}}` branch per option, each a whole `formula` block (`@root`, so it also works inside `{{#each}}`).
- **Size**: each rendered formula adds a few KiB, and the template must stay under 64 KiB (§8 of the spec). Keep the pool small.
- **Stylesheet**: ship KaTeX's own `katex.min.css` unchanged (listed in `files.styles` before your own stylesheet), except its `@font-face` rules. The platform handles KaTeX's paint order and the U+200B it prints in `.vlist-s`, so the pack needs no overrides.
- **Fonts**: keep only the `@font-face` rules for faces your formulas print. `check-pack` can't tell which those are, because KaTeX's stylesheet names every KaTeX family, so work them out from the rendered HTML and KaTeX's CSS rules together. A class name alone misses inherited bold or italic, scalable delimiters and large operators: the paper's `build.test.ts` (`neededFaces`) does it for every formula in the pool. A face you leave out prints wrong: in a fallback font, which fails the self-check, or as a style Chrome synthesizes from another shipped face (bold from regular), which the self-check doesn't catch. A face you add for nothing only makes the pack bigger, and Paged.js downloads every declared face before it paginates. Give each one a single `src` pointing at the woff2 copied from the `katex` package, relative to the stylesheet, and list the files in `files.assets`:

```css
@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:400;src:url(../fonts/KaTeX_Main-Regular.woff2) format("woff2")}
```

- **Spacing**: put the space around a formula in the block's padding, not its margin, and zero KaTeX's own display margin. A tall fraction or a big operator reaches above KaTeX's box, and the gt box (the block's border box) must hold every printed glyph. Inside columns, the formula needs `break-inside: avoid` like every other block:

```css pack-ok
.equation {
  margin: 0.5mm 0;
  padding: 1.5mm 0;
  break-inside: avoid;
}

.equation .katex-display {
  margin: 0;
}
```

The full setup is `$PDF_GENERATOR_REPO/templates/paper/`: `src/formulas.ts` (the LaTeX pool), `src/build.ts` (renders the branches, trims the stylesheet, copies the fonts) and `src/build.test.ts` (fails when the generated files are stale or a printed face isn't shipped).

## Landscape

`"orientation": "landscape"` in the manifest; nothing else. The manifest wins over `@page { size }`.

## Try more records

`check-pack` fills only `sample.json`. Run the same check with 30 generated records to catch fill errors on blanks and short arrays (from the pack folder). The marks, HTML and CSS are checked once whatever the record, so this doesn't catch the print traps at the end of this file:

```sh
node --input-type=module -e "
import { generate } from '$PDF_GENERATOR_REPO/packages/fake-data/src/index.ts';
import { checkPack } from '$PDF_GENERATOR_REPO/packages/template-tools/src/index.ts';
import { readdirSync, readFileSync } from 'node:fs';
const files = Object.fromEntries(readdirSync('.', { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => [(e.parentPath + '/' + e.name).replace(/^\.\//, ''), readFileSync(e.parentPath + '/' + e.name)]));
const manifest = JSON.parse(files['manifest.json']);
const rules = JSON.parse(files[manifest.files.rules]);
let bad = 0;
for (let i = 1; i <= 30; i++) {
  const record = generate(rules, 'try-' + i);
  const { issues } = checkPack({ ...files, [manifest.files.sample]: JSON.stringify(record) });
  if (issues.length) { bad++; console.log('try-' + i, issues.map(x => x.code + ': ' + x.message).join('; ')); }
}
console.log(bad ? bad + '/30 records fail' : '30/30 records pass');"
```

## Print traps the checker can't see

These pass `check-pack` and fail when the platform prints or self-checks the PDF:

| Trap | Fix |
| --- | --- |
| Two inline marks in the same font touching (`<span data-gt="label">…</span><span data-gt="field">…</span>`) merge into one PDF text item | Bold label plus a margin, or put each block on its own line, or use table cells |
| Text longer than its box: clipped (`overflow: hidden`, fixed height) or off the page | Bound `maxLength`/`maxItems` in the rules; no fixed heights on text |
| A platform font named only inside `@page` or `@media print`, or in an `@import`ed sheet | Set `font-family` on `html` and on the elements in your stylesheet |
| A character no platform font has (a rare 字, an emoji) | Common characters only; ☑ ☐ in `"Noto Sans Symbols 2"` |
| Text in inline `<svg>` (`<text>`) | Put it in an HTML mark next to the drawing |
| A table row taller than a page | Short cell texts; `maxItems` on nested arrays |
| Ellipsis, `text-transform`, `letter-spacing` tricks that change the printed text | Print the text as it is in the data |
| A blank field (a `null` value, a signature line) with a size but no border, underline or background: the block has no text and paints nothing, so its box can't be checked (`ink`) | `border-bottom: 0.5pt solid #000`, a border or a background on the field itself |
| A line or drawing inside a text-free block that is neither on an edge nor centred (an underline raised with `::after { bottom: 4pt }`), or one spilling out of its box (`ink`) | Draw on the block's own border or background, or centre the drawing |
| A very long formula in one `formula` block, many of its printed pieces made of the same few characters (`formula_undecided`: the self-check's match budget runs out, and that never passes) | Simplify it, or split it into several `formula` blocks, each with its own `data-gt-latex` |
| Something visible but unmarked (a border-drawn box is fine; a `content:` glyph is not) | Draw with borders and backgrounds; write text into marks |
