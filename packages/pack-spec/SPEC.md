# Template pack spec

How to write a **template pack** (樣板包): the files the platform turns into PDF fixtures with an exact ground truth (`gt.json`). Read it whole before writing a pack; the [minimal example](../../templates/minimal-example/README.md) follows every rule here and is the place to start. For a large form (a big table, merged cells, blank cells, checkboxes in cells), see the [incident form](../../templates/incident-form/README.md) (T23).

What decides is code, not this text: the shared contract (`packages/contract`: manifest, rules, `gt.json`, block types, exported as JSON Schema in `packages/contract/schemas`) and the pack checker (`checkPack` in `packages/template-tools`). This spec describes what they accept. Its `pack-ok` and `pack-error` examples are run through `checkPack` by `src/spec.test.ts`, so they can't drift from the checker; where the spec and the code still disagree, the code wins and the spec has a bug.

A pack passes three gates, and a good pack passes all three on the first try:

1. **Check** (`checkPack`, on upload and locally): files, schemas, the sample record, the HTML/CSS allowlist, the `data-gt` marking. Every issue has a `code`, a file and usually a line and column.
2. **Print**: the record filled into the template, printed to A4 by Chrome with Paged.js; the ground truth is read from the printed page. A print can fail (a font that didn't load, a table row Paged.js would drop, a `data-gt` block whose text the PDF lacks).
3. **Self-check**: the PDF's text, positions and fonts compared with `gt.json`. Every difference is a defect of the fixture.

## 1. Layout

### In this repository

Every pack is a workspace package at `templates/<name>/`, named `@pdf-generator/<name>`:

| Path | What |
| --- | --- |
| `templates/<name>/pack/` | The pack itself: exactly the files of the upload zip. |
| `templates/<name>/src/*.test.ts` | Node tests: at least `checkPack` with zero issues on `pack/`. |
| `templates/<name>/README.md` | What the document is, what it demonstrates, how to check it. |
| `templates/<name>/package.json` | `check-pack` and `test` scripts, as in the minimal example. |

### In the zip

`manifest.json` sits at the **root** of the zip: zip the contents of `pack/`, not the folder (`manifest-missing` otherwise). Every other file is listed in the manifest (`file-unlisted`), and every listed file exists (`file-missing`). Paths are relative to the zip root, `/`-separated, with no `..`, `.`, leading `/`, backslash or control character (`path-invalid`). A conventional layout:

```text
manifest.json
template.hbs
styles/word.css        (a copy of word.css, first)
styles/<pack>.css      (the pack's own rules)
data/rules.json
data/sample.json
assets/…               (images, fonts)
```

### manifest.json

| Key | Rule |
| --- | --- |
| `schemaVersion` | `1` |
| `id` | Lower-case kebab-case, 1-64 characters (`company-monthly-report`). Stable: a new upload with the same id is a new version of the same template. |
| `name` | Display name, 1-200 characters, e.g. `公司月報`. |
| `description` | Optional, up to 2000 characters. |
| `page` | `{ "size": "A4", "orientation": "portrait" \| "landscape" }`. Only A4. The orientation here wins over any `@page { size }` in the CSS. |
| `files.template` | The Handlebars template, ending in `.hbs`. |
| `files.styles` | Stylesheets (`.css`), applied in this order. May be empty. |
| `files.rules` | The fake-data rules (`.json`), §2. |
| `files.sample` | A sample record (`.json`) the rules could produce, §2. |
| `files.assets` | Optional: every other file the template or CSS loads (images, fonts). |

No path may be listed twice. Unknown keys are errors everywhere (the schemas are strict).

## 2. Data: rules.json and sample.json

`rules.json` tells the seeded fake-data engine how to build one record: `{ "schemaVersion": 1, "fields": { … } }`. Field keys match `[A-Za-z_][A-Za-z0-9_]*`, so every key is a Handlebars name. Each field has a `type`, an optional `description`, and an optional `blankProbability` (0-1: the chance the value is `null`, printed blank).

| `type` | Extra keys | Value |
| --- | --- | --- |
| `name` | `gender?`: `male` \| `female` \| `any` | Chinese full name |
| `nationalId` | `gender?` | 身分證字號 with a valid check digit |
| `businessId` | | 統一編號 with a valid check digit |
| `company` | | Company name |
| `address` | `cities?`: list of the 22 official 縣市 (`臺北市`, …) | Taiwanese postal address |
| `phone` | `kind`: `mobile` \| `landline` | Taiwanese phone number |
| `date` | `min`, `max`: `YYYY-MM-DD` | `YYYY-MM-DD` string |
| `money` | `min`, `max`, `decimals?` (0-2) | Number (TWD) |
| `integer` | `min`, `max` | Integer |
| `number` | `min`, `max`, `decimals` (0-6) | Number |
| `choice` | `options` (strings, numbers, booleans), `weights?` | One option |
| `text` | `lang`: `zh` \| `en` \| `mixed`, `minLength`, `maxLength` | Filler text, length in characters |
| `checkbox` | `probability?` (chance it is checked) | Boolean |
| `constant` | `value` | Always `value` |
| `object` | `fields` | Nested record |
| `array` | `minItems`, `maxItems`, `items` (one field rule) | List, e.g. table rows |
| `sum` | `of`: field paths | Sum of the values (`null` counts as 0) |
| `runningBalance` | `opening`, `add`, `subtract`: field paths | Inside an array item: opening + Σ add − Σ subtract over rows 0..i |
| `percentage` | `part`, `whole`, `decimals` | part / whole × 100 |

Field paths (`sum`, `runningBalance`, `percentage`) go from the record root, `.`-separated, with `[]` after an array field, and must name a numeric field: `transactions[].amount`. Every `min` is ≤ its `max`; `weights` has one entry per option and a positive sum.

`sample.json` is one record of exactly that shape, written by hand: the check validates it against the rules (`sample-invalid`) and fills the template with it (`template-render`). It must be a record the rules could produce: lengths within `minLength`/`maxLength`, dates within range, identifiers with valid check digits, `null` only where `blankProbability` allows it, or for a `percentage` whose `whole` is 0 (it is then `null`, printed blank, §5).

The engine draws only characters the platform fonts cover. Text you write yourself (labels, headings, sample values) must stay inside them too (§6).

## 3. The template

One complete HTML document: `<!doctype html>`, `<html lang="zh-Hant-TW">`, a `<head>` with `<meta charset="utf-8">` and an explicit `</head>`, then `<body>`. The platform links the pack's stylesheets, in `files.styles` order, with `<link rel="stylesheet">` right before `</head>`, so don't link them yourself; their `url()`s resolve against each stylesheet's own path, as `checkPack` checks them.

### Handlebars

Only an eval-free subset (`fill` in `packages/template-tools`):

| Construct | Notes |
| --- | --- |
| `{{field}}`, `{{a.b}}`, `{{this}}`, `{{../x}}` | Escaped output. A field the record lacks is an error (`template-render`, `template-unknown-field`); `null` prints nothing; booleans print `true`/`false`. |
| `{{#if x}}…{{else}}…{{/if}}`, `{{#unless x}}` | |
| `{{#each list}}…{{/each}}`, `{{#with obj}}` | `@index`, `@key`, `@first`, `@last`, `@root`, block params (`as \|row\|`). |
| `{{eq a b}}`, `{{lookup obj key}}` | Mostly as sub-expressions: `{{#if (eq status "已結案")}}`. |
| `{{number x}}`, `{{number x decimals=2}}` | Thousands separators: `1,234,567`; `decimals` 0-20. |

Anything else is `template-unsupported`: raw output (`{{{x}}}`, `{{& x}}`), partials, decorators, other helpers. Dates print as stored (`YYYY-MM-DD`); there is no date or 民國年 helper yet.

**Where statements may sit.** The checks see the HTML with the Handlebars statements taken out, so a statement must not change the HTML structure (`template-structure`). Put `{{…}}` in text or in a quoted attribute value. Never inside a tag outside a quoted value, right after `<`, in CSS (`<style>` or `style="…"`), in an HTML comment, or as a block statement (`{{#if}}`) inside a URL (`src`, `href`) or inside `<title>`/`<textarea>`. An element must open and close within the same `{{#…}}`/`{{else}}` branch (`gt-branch`): to print one of two elements, put each element whole in its branch.

```html pack-error template-structure
<p data-gt="paragraph" {{#if confirmed}}class="ok"{{/if}}>{{summary}}</p>
```

```html pack-ok
{{#if confirmed}}
<p data-gt="paragraph" class="ok">{{summary}}</p>
{{else}}
<p data-gt="paragraph">{{summary}}</p>
{{/if}}
```

### HTML allowlist

A pack may use only what a printed document needs, so it prints the same way every time and nothing runs or fetches (the allowlist is in `packages/template-tools/src/policy.ts`). Anything else is `html-unsupported`; code is `html-active`.

- **Elements**: document structure (`html`, `head`, `body`, `meta`, `title`, `style`, `link rel="stylesheet"`), sections (`div`, `header`, `footer`, `main`, `section`, `article`, `aside`, `nav`, `address`), text (`p`, `h1`-`h6`, `span`, `br`, `wbr`, `hr`, `pre`, `code`, `blockquote`, `q`, `strong`, `em`, `b`, `i`, `u`, `s`, `small`, `sub`, `sup`, `mark`, `abbr`, `cite`, `dfn`, `kbd`, `samp`, `var`, `bdi`, `bdo`, `ruby`, `rt`, `rp`, `time`, `data`, `del`, `ins`, `a`), lists (`ul`, `ol`, `li`, `dl`, `dt`, `dd`), tables (`table`, `caption`, `colgroup`, `col`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`), media (`img`, `picture`, `source`, `figure`, `figcaption`), form look-alikes (`label`, `input` of type `checkbox`, `radio` or `text`, `textarea`), `template`; inline `svg` (static drawing elements) and `math` (MathML, e.g. KaTeX output).
- **Attributes**: `class`, `id`, `style`, `lang`, `dir`, `title`, `hidden`, `translate`, `role`, `aria-*`, `data-*`, plus each element's own (`colspan`, `rowspan`, `src`, `alt`, `width`, `checked`, Word's legacy `align`, …).
- **Never**: `<script>`, `<base>`, `<meta http-equiv="refresh">`, `on*` handlers, `srcdoc`, `<iframe>`, `<object>`, `<embed>`, `<canvas>`, `<video>`, forms, `<select>`, buttons.

```html pack-error html-active
<p data-gt="paragraph" onclick="alert(1)">{{summary}}</p>
```

The print browser runs no pack JavaScript and loads nothing from the network; a URL that leaves the pack is `asset-external`, a root-relative or escaping one is `asset-path`, a missing file is `asset-missing`. `data:` URLs are accepted (not as a stylesheet: `asset-data`).

**Pack files.** The preview and every batch send the pack's files to the print service, and the template is loaded at its own pack path, so a relative URL (`assets/logo.png` from `template.hbs`, `../assets/font.woff2` from `styles/report.css`) loads the file as in the pack. Nothing outside the pack loads, apart from the platform fonts.

```html pack-error asset-external
<img data-gt="image" src="https://example.com/logo.png" alt="logo">
```

## 4. Marking the ground truth: `data-gt`

**The rule: everything the template prints sits inside exactly one element marked `data-gt="<block type>"`.** That element is one block of `gt.json`: its type, its text (the element's rendered text, `innerText`), its page and its bounding box. Text outside every mark is `gt-unmarked`; an image, SVG, input or formula outside every mark is `gt-unmarked` too. A mark inside another mark is `gt-nested` (its text would be counted twice). Wrappers without text (a `<div>` holding marked children) need no mark.

```html pack-ok
<p class="pair"><span data-gt="label">會議日期：</span><span data-gt="field">{{meetingDate}}</span></p>
```

```html pack-error gt-unmarked
<p><span data-gt="label">會議日期</span>：<span data-gt="field">{{meetingDate}}</span></p>
```

```html pack-error gt-nested
<p data-gt="paragraph">主席<span data-gt="field">{{chair}}</span></p>
```

Mark the unit a layout model should find: a label and its value are two blocks, a whole paragraph is one block, each list item is one block. Punctuation that belongs to a label (`：`) goes inside the label.

### Block types

The types of `gt.json` and of the local block list (`blockTypes` in `packages/contract/src/layout.ts`):

| Type | Use for | Notes |
| --- | --- | --- |
| `title` | The document's title | Usually one per document. |
| `heading` | Section and subsection headings | |
| `paragraph` | Running text | One block per paragraph. |
| `list_item` | One item of a list | The list marker must be inside the item's own text (§5). |
| `label` | The printed caption of a form value: `姓名：` | |
| `field` | The value next to a label | May be blank (`null`): give it a width (§5). |
| `table` | A `<table>` | On the `<table>` element only (`gt-table`); its cells carry no `data-gt` (§4.2). |
| `image` | `<img>`, `<svg>`, a logo or stamp | `data-gt-text` declares text drawn inside it. |
| `caption` | A figure or table caption | |
| `formula` | A formula | Needs its LaTeX (§4.3). |
| `checkbox` | A checkbox with its label: `☑ 已確認` | Needs its state (§4.1). |
| `barcode` | A barcode or QR code (as an image or SVG) | |
| `page_header` | Text in the top page margin | A running element (§5). |
| `page_footer` | Text in the bottom page margin | A running element (§5). |
| `page_number` | A page number | Must be real text in the DOM; see §5 for why `counter(page)` doesn't work. |
| `footnote` | A footnote | |
| `reference` | A bibliography entry | |

```html pack-error gt-type
<p data-gt="text">{{summary}}</p>
```

### Attributes

| Attribute | On | Meaning |
| --- | --- | --- |
| `data-gt` | Any element that prints | The block type. |
| `data-gt-id` | A marked element | Optional id in `gt.json` (`A-Za-z0-9_-`, up to 60 characters, `gt-id`). Without it the id is `<type>-<n>`. A repeated id (a mark inside `{{#each}}`) gets `-2`, `-3`, … |
| `data-gt-checked` | A `checkbox` block, or a checkbox mark inside a table cell | `true`, `false` or a single `{{field}}` holding a boolean. |
| `data-gt-latex` | A `formula` block | The formula's LaTeX. |
| `data-gt-text` | An `image` block | The text drawn inside the image (an image of a stamp reading 核准). The image must then contain no printed text (`gt-image-text`). |

Any other `data-gt-*` is a typo (`gt-attribute`), and a detail attribute on the wrong type or without `data-gt` is too.

```html pack-error gt-attribute
<p data-gt="paragraph" data-gt-checked="true">{{summary}}</p>
```

### 4.1 Checkboxes

A `checkbox` block states whether it is checked, either with `data-gt-checked` or with exactly one `<input type="checkbox|radio">` inside it (`gt-checkbox` otherwise). Print the state the PDF can show: a glyph (☑ ☐ from Noto Sans Symbols 2) whose choice follows the same field. The self-check reads the printed glyph and compares it with the state.

```html pack-ok
<p data-gt="checkbox" data-gt-checked="{{confirmed}}"><span class="box">{{#if confirmed}}☑{{else}}☐{{/if}}</span>本紀錄已經主席確認無誤。</p>
```

`data-gt-checked` takes `true`, `false` or one plain `{{field}}`: not a block statement, not a negation. For a "□是 □否" pair driven by one boolean, print each pair whole in its branch:

```html pack-error gt-attribute
<p data-gt="checkbox" data-gt-checked="{{#if confirmed}}false{{else}}true{{/if}}">☐ 未確認</p>
```

### 4.2 Tables

`data-gt="table"` goes on the `<table>`; the reader builds the grid itself: every printed cell with its row, column, `rowspan`/`colspan`, its text and box, and whether it is a header cell (a `<th>`, or any cell of a `<thead>` row). Cells carry no `data-gt` (`gt-table`). Merged cells are plain `rowspan`/`colspan`. An empty cell is a cell with empty text.

**Checkboxes inside a cell** (`cell.checkboxes` in `gt.json`): mark each box element inside the `<td>` with `data-gt-checked` alone, no `data-gt`. The option's label is the text after the box up to the next box. The box's own glyph is part of the cell text.

```html pack-ok
<table data-gt="table">
<thead><tr><th>姓名</th><th>是否出席</th></tr></thead>
<tbody>
{{#each attendees}}
<tr><td>{{name}}</td><td>{{#if present}}<span data-gt-checked="true">☑</span>是　<span data-gt-checked="false">☐</span>否{{else}}<span data-gt-checked="false">☐</span>是　<span data-gt-checked="true">☑</span>否{{/if}}</td></tr>
{{/each}}
</tbody>
</table>
```

A table that breaks across pages becomes one `table` block per page; each later fragment has `continues` pointing at the fragment on the page before it, and its grid is the rows printed on that page. The platform repeats the `<thead>` rows on every page and keeps each row whole (a row taller than a page can't print). Give tables fixed column widths (`table-layout: fixed` with `<col>` widths, as `word.css` does), or Paged.js lays each fragment out with different widths.

### 4.3 Formulas and images

A `formula` block needs its LaTeX: `data-gt-latex`, or the `<annotation encoding="application/x-tex">` KaTeX puts inside its MathML (`gt-formula` otherwise). The block's text is what KaTeX visibly renders; the hidden MathML copy doesn't count. KaTeX's HTML must be pre-rendered into the template (no scripts run), and its fonts are pack fonts (§6).

An `image` block's text is `data-gt-text` if present, else the rendered text of an HTML element inside it, else empty. **Text drawn by inline SVG (`<text>`) is not read**: the block's text is empty, the PDF still prints the text, and the self-check fails. Keep text out of inline SVG: put it in HTML next to the drawing, in its own mark.

### Reading order

`gt.json` orders blocks page by page; within a page: the top margin (headers), the left margin, the page body, the right margin, the bottom margin (footers); within each, document order. So write the template in reading order: a two-column layout reads the left column first only if it comes first in the HTML.

## 5. Print rules and pitfalls

- **A4**, in the manifest's orientation. Paged.js paginates; `@page` margins and margin boxes work; `break-before`, `break-after: avoid`, `break-inside: avoid` work.
- **No pack JavaScript** runs, and the browser loads only the pack's own files and the platform fonts.
- **Headers and footers** are running elements: an element with `position: running(<name>)` that `@page { @top-center { content: element(<name>) } }` (or another margin box) shows on every page from the one where it appears. Put it first in `<body>` and mark it `page_header` or `page_footer`. `word.css` provides `.word-header` and `.word-footer`.
- **Only marked text may print.** CSS generated content prints text that is in no element, so the self-check reports it as unmarked text: no `content: "…"`, `counter()` or `counter(page)` in `::before`/`::after` or in margin boxes. Page numbers must be DOM text inside a `page_number` mark; a number that depends on how many pages the record fills can't be known at fill time, so number pages only where the page count is fixed by the layout.
- **List markers** are generated content too, outside the box (`list-style-position: outside`) or inside it: either way the self-check reports them. Use `list-style: none` and write the marker into the item's text (`・{{this}}`, or `（一）` in a fixed list). A list from an array can't number itself: there is no helper that adds 1 to `@index`.
- **Blank fields**: a field that can be `null` (`blankProbability`, or a `percentage` of a zero `whole`) prints an empty element, whose box is empty (an inline element has no width, an inline-block no height). The print then fails with `ground_truth_invalid`, since a box must have `x0 < x1` and `y0 < y1`. Give the element a size of its own: `display: inline-block; min-width: 6em; min-height: 1lh` (as the minimal example does), or put it in a table cell.
- **Every `data-gt` block's text must reach the PDF.** A block hidden with `display: none` is skipped, but text clipped by `overflow: hidden`, pushed off the page or painted over is still in `gt.json`; the print or self-check fails on it.
- **Tables**: rows are kept whole and the header repeats (above). Keep rows shorter than a page.

## 6. Fonts

Use the platform fonts by family name; they are always available and embedded in every PDF:

| Family | Replaces (Word) | Weights |
| --- | --- | --- |
| `"Noto Serif TC"` | 新細明體 (明體, serif) | regular, bold |
| `"Noto Sans TC"` | 微軟正黑體 (sans) | regular, bold |
| `"LXGW WenKai TC"` | 標楷體 (kai) | regular only |
| `"Noto Sans Symbols 2"` | Symbols: ☑ ☐ | regular only |

Put `"Noto Sans Symbols 2"` in the font list wherever ☑ ☐ print. Don't declare `@font-face` for them. Name a platform font on the elements that print (or inherit it), not only inside `@page { … }` or `@media print { … }`: the print runtime finds the platform fonts a document uses from the elements' styles and from `<style>` elements only, not from linked stylesheets' at-rules, and a font it doesn't find is not loaded. Bold of WenKai and Symbols 2 is synthesized.

**Missing glyphs are errors.** A character no listed font has (for example 㵾, or 𩸽 outside WenKai) falls back to a system font, and the self-check fails on any font but the pack's: keep fixed text and `choice` options within these fonts.

**Pack fonts** (a `.woff2`/`.ttf`/`.otf` in `files.assets` with an `@font-face` whose `src: url()` is relative to the stylesheet) print like the platform fonts; the batch self-check also accepts each pack font under its PostScript name (read from the font file), so text in it is not a font error. Declare only faces the document uses (`font-unused`): Paged.js downloads every declared face before it paginates.

```css pack-error font-unused
@font-face {
  font-family: "Unused";
  src: url("../assets/missing.woff2");
}
```

## 7. Word-style CSS

[`word.css`](word.css) makes a pack print like a Word document with the zh-TW Normal template, so a pack converted from a Word original starts close to it:

| Word setting | `word.css` |
| --- | --- |
| A4, margins 2.54 cm top and bottom, 3.17 cm left and right | `@page { size: A4; margin: 25.4mm 31.7mm }` |
| Header 1.5 cm from the top, footer 1.75 cm from the bottom | `.word-header` / `.word-footer` in `@top-center` / `@bottom-center` |
| 內文: 新細明體 12 pt, single spacing, no paragraph spacing, justified | `html { font-family: "Noto Serif TC", …; font-size: 12pt; line-height: normal }` (Word's single spacing is the font's own line height), `p { margin: 0; text-align: justify }` |
| 標題 1-3 | `h1` 24 pt, `h2` 18 pt, `h3` 14 pt, bold; `.word-title` 16 pt bold centered |
| 表格格線 (Table Grid) | 0.5 pt black borders, 0.19 cm cell padding, full width, fixed layout |

**Copy it, don't import it.** A pack is a self-contained zip: copy `word.css` into the pack (`styles/word.css`), list it **first** in `files.styles`, and put every change in your own second stylesheet, so the copy stays identical to this file and a later fix can be copied over it. `@import` of a file outside the pack is `asset-path`.

```css pack-ok
.pair {
  text-align: left;
}

.box {
  font-family: "Noto Sans Symbols 2", "Noto Serif TC", serif;
}
```

**How close it is.** The minimal example was printed next to a Word-equivalent reference: the same record as a `.docx` with exactly these settings (`templates/minimal-example/src/word-reference.ts`), converted to PDF by LibreOffice 25.2 with the same fonts. Every word that both PDFs print as one word sits within 0.4 pt horizontally and 1.6 pt vertically of its place in the other. Known differences:

- Word and LibreOffice add a small gap between Chinese and Latin characters or digits (`100 臺北市`); Chrome doesn't. Don't add spaces to imitate it: they would be in the text.
- Word's heading sizes and spacings in `word.css` follow the zh-TW Normal template as documented, not as measured in Word: there is no Word here.

## 8. Limits

An upload is refused before the check when it breaks one of these (`apps/web/src/templates/limits.ts`):

| Limit | Value |
| --- | --- |
| Zip as uploaded | 10 MiB |
| Pack unzipped, all files | 20 MiB |
| One file (the print service's limit) | 16 MiB |
| Number of files | 200 |
| One text file (anything but `.png .jpg .jpeg .gif .webp .woff .woff2 .ttf .otf`) | 64 KiB |
| All text files together | 256 KiB |

Keep the template a template: a `{{#each}}` over rows, not 500 copied rows.

## 9. Checking a pack

```sh
pnpm --filter @pdf-generator/<name> check-pack      # in this repo: ok: <id>, exit 0
node packages/template-tools/src/cli.ts <dir or .zip> [--json]
```

Exit 0: the pack passes; 1: it has issues (one per line, `file:line:column: code: message`); 2: usage error. The web app runs the same check on upload and explains each code in Chinese. The codes:

| Code | Meaning |
| --- | --- |
| `zip-invalid`, `pack-too-large`, `pack-too-complex`, `path-invalid` | The zip itself |
| `manifest-missing`, `manifest-invalid`, `json-syntax`, `file-missing`, `file-unlisted`, `text-encoding` | Files and manifest (§1) |
| `rules-invalid`, `sample-invalid` | Data (§2) |
| `template-syntax`, `template-unsupported`, `template-unknown-field`, `template-render`, `template-structure` | Handlebars (§3) |
| `html-active`, `html-unsupported` | The allowlist (§3) |
| `asset-external`, `asset-path`, `asset-missing`, `asset-data`, `asset-dynamic`, `css-escape` | Files the template or CSS loads |
| `font-unused` | Fonts (§6) |
| `gt-unmarked`, `gt-nested`, `gt-type`, `gt-attribute`, `gt-id`, `gt-branch`, `gt-table`, `gt-checkbox`, `gt-formula`, `gt-image-text` | Marking (§4) |

Passing the check is not the end: print a few records (the web app's preview, then a small batch) and read the self-check report. Something it flags is a defect of the pack.
