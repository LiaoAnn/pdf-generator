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

/* recorder can be blank: an empty element needs a box of its own. */
.value {
  display: inline-block;
  min-width: 6em;
  min-height: 1lh;
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

Your own margins and margin boxes: see `$PDF_GENERATOR_REPO/templates/monthly-report/pack/styles/` (`position: running(…)` and `content: element(…)` in `@page`). No page numbers unless the page count is fixed by the layout (then write `第 1 頁` as text in a `page_number` mark).

## Optional sections

A field with `blankProbability` that drops a whole section: put the heading and the text in the same branch, so a blank record prints neither.

```html pack-ok
{{#if recorder}}
<h2 data-gt="heading">記錄人</h2>
<p data-gt="paragraph">{{recorder}}</p>
{{/if}}
```

## Dates, money, numbers

- `date` fields print `YYYY-MM-DD`; there is no date helper. For 民國 dates, use `integer` fields (`year` 110-115, `month` 1-12, `day` 1-28) and print `民國{{year}}年{{month}}月{{day}}日`.
- Dates that must agree (start ≤ end, rows within a trip): each `date` field is drawn on its own, so give them ranges that can't cross instead of pinning them to one day: start in `2026-03-02`..`2026-03-06`, end in `2026-03-09`..`2026-03-13`, row dates in `2026-03-06`..`2026-03-09`. Rows of an array are not sorted by date.
- Money: `money` with `decimals: 0` and `{{number amount}}`; amounts with cents: `decimals=2`.
- Derived values (`sum`, `percentage`, `runningBalance`) come from the rules, never from the template: there is no arithmetic in templates.

## Landscape

`"orientation": "landscape"` in the manifest; nothing else. The manifest wins over `@page { size }`.

## Try more records

`check-pack` fills only `sample.json`. Run the same check with 30 generated records to catch blanks, longest texts and shortest arrays (from the pack folder):

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
| Something visible but unmarked (a border-drawn box is fine; a `content:` glyph is not) | Draw with borders and backgrounds; write text into marks |
