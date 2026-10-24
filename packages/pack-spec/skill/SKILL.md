---
name: write-template-pack
description: Write a pdf-generator template pack (樣板包: manifest, Handlebars HTML, CSS, fake-data rules, sample record, data-gt ground-truth marks) from a layout description or a de-identified block list, and check it with check-pack until it passes. Use when asked to make, convert or fix a template pack for the pdf-generator platform. Does not upload.
---

# Write a template pack

You turn a layout description ("一頁 A4 請款單，上方公司抬頭，中間品項表格，下方簽核欄") or a de-identified block list into a **template pack** for the pdf-generator platform: a folder the platform fills with fake Taiwanese data, prints to PDF and reads an exact ground truth (`gt.json`) from. The ground truth is only as good as the marks: every printed character must sit in exactly one `data-gt` block, and every block must print exactly the text it claims. A pack that passes `check-pack` can still fail at print time; the rules below avoid both.

You deliver a pack folder that passes `check-pack` with exit 0. You never upload it (the caller does that).

## Setup: the platform repo

Everything this skill points at lives in the pdf-generator repo, written here as paths under `$PDF_GENERATOR_REPO`. Use the environment variable if it is set; otherwise it is the git root of this skill's real location:

```sh
: "${PDF_GENERATOR_REPO:=$(git -C "$(dirname "$(realpath SKILL.md)")" rev-parse --show-toplevel)}"
```

(Run that from this skill's folder, or substitute the folder's path. If your shell doesn't keep variables between commands, start each command with that line, or with `PDF_GENERATOR_REPO=<path>`.) The repo needs `pnpm install` once; the checker and the data engine are TypeScript that Node 24 runs directly.

**Installing** (for the caller, e.g. `pdf2tpl`): symlink `$PDF_GENERATOR_REPO/packages/pack-spec/skill/` into the project's `.claude/skills/write-template-pack`, or copy it there and set `PDF_GENERATOR_REPO`.

## Read first

1. The spec, whole: `$PDF_GENERATOR_REPO/packages/pack-spec/SPEC.md`. It is the contract the checker enforces; this skill only adds the working method and the traps.
2. The example nearest your document, as a model to copy from (open its `manifest.json`, `data/rules.json`, then the template and its own stylesheet). None is a ledger or landscape; take the closest parts from each:
   - `$PDF_GENERATOR_REPO/templates/minimal-example/pack/`: one-page minutes; label/value pairs, a table with checkbox cells, a list, a checkbox, a blank field, a footer.
   - `$PDF_GENERATOR_REPO/templates/monthly-report/pack/`: multi-page report; running header and footer, bullet lists, a figure with text, tables that break across pages, sums and percentages.
   - `$PDF_GENERATOR_REPO/templates/incident-form/pack/`: a one-page form built as one big table; merged cells, blank cells, checkbox options in cells.
3. [references/recipes.md](references/recipes.md): checked snippets for each common layout element (two columns and KaTeX formulas included), and the print-time traps the checker can't see.
4. [references/check-codes.md](references/check-codes.md): what each `check-pack` code means and how to fix it.

## Workflow

1. **Plan the blocks.** From the description, list every printed element top to bottom (reading order) with its block type (spec §4 table): title, headings, label/field pairs, paragraphs, list items, tables, checkboxes, header/footer. Decide what is fixed text and what is data. Keep it to what the description asks for; one page unless it says otherwise.
2. **Make the folder** (anywhere outside the platform repo, unless told otherwise):
   ```text
   <pack>/manifest.json
   <pack>/template.hbs
   <pack>/styles/word.css       copied verbatim from $PDF_GENERATOR_REPO/packages/pack-spec/word.css, listed first
   <pack>/styles/<pack>.css     your rules
   <pack>/data/rules.json
   <pack>/data/sample.json
   ```
   Copy `word.css` with `cp`, never retype or edit it: `cp "$PDF_GENERATOR_REPO/packages/pack-spec/word.css" <pack>/styles/word.css`. Start `manifest.json` from the minimal example's and change `id`, `name`, `description`, `page.orientation` and the file names.
3. **Write `rules.json`** (spec §2): one field per data value, with ranges that keep the layout intact: `maxLength` on text so a cell or line can't overflow, `maxItems` on arrays so tables stay as long as the description implies. Use the Taiwanese types (`name`, `nationalId`, `businessId`, `company`, `address`, `phone`) rather than `text` for those values.
4. **Generate `sample.json`** with the engine. The spec says the sample is written by hand; what the check needs is a record the rules could produce, and the engine's own output is exactly that, without the hand-written check digits and lengths that cause most `sample-invalid`:
   ```sh
   cd <pack> && node --input-type=module -e "
   import { generate } from '$PDF_GENERATOR_REPO/packages/fake-data/src/index.ts';
   import { readFileSync, writeFileSync } from 'node:fs';
   const rules = JSON.parse(readFileSync('data/rules.json', 'utf8'));
   writeFileSync('data/sample.json', JSON.stringify(generate(rules, 'sample'), null, 2) + '\n');"
   ```
   An error here is a rules error: fix `rules.json` and rerun.
5. **Write `template.hbs` and `<pack>.css`** from the recipes. Mark every printed element; write fixed text inside its mark; name platform fonts on elements; give blank-able fields a box.
6. **Check** and repeat until it prints `ok: <id>`:
   ```sh
   node "$PDF_GENERATOR_REPO/packages/template-tools/src/cli.ts" <pack>
   ```
   Exit 0 passes; exit 1 prints one `file:line:column: code: message` per issue (look each code up in [references/check-codes.md](references/check-codes.md)); exit 2 is a usage error. Fix causes, not symptoms: never delete a mark or a field just to silence an issue if it drops something the description asked for.
7. **Fill a few more records** to catch fill errors one sample hides (a `{{#each}}` or lookup that breaks on a blank or short value): see "Try more records" in [references/recipes.md](references/recipes.md). It does not catch a blank field without a box or text that overflows; those are print traps, avoided by the rules below.
8. **Report**: the pack path, the `check-pack` output, the block list you planned, and anything in the description you could not express (and why). Printing is not your step: the caller uploads the pack and runs the platform's preview and batch self-check (spec §9), which is why the traps in [references/recipes.md](references/recipes.md) matter.

## Rules you must not break

These are the ones agents get wrong; the spec has the rest.

- **Every printed character is inside exactly one `data-gt` element**, including fixed labels, punctuation (`：` goes in the label), table text (the `<table>` is the block; its cells carry no `data-gt`), list markers (write `・` into the item) and the footer. No marks inside marks.
- **No generated text**: no `content: "…"`, `counter()`, `counter(page)` or list markers (`list-style: none`). They print text no block holds.
- **No `<script>`, no URLs that leave the pack, no `{{{raw}}}`, no helpers but `eq`, `lookup`, `number`, `rocDate`** (and the built-in `if`/`unless`/`each`/`with`).
- **Handlebars only in text or in quoted attribute values**, and an element opens and closes in the same `{{#if}}` branch: to switch an attribute, duplicate the whole element in each branch.
- **Fonts**: only the platform families (`"Noto Serif TC"`, `"Noto Sans TC"`, `"LXGW WenKai TC"`, `"Noto Sans Symbols 2"`), named in the `font-family` of the printed elements in your stylesheet; `"Noto Sans Symbols 2"` first wherever ☑ ☐ print. No `@font-face` for them, no `@import`. The one exception is pack fonts a layout needs, such as KaTeX's for formulas (spec §6, "Formulas (KaTeX)" in [references/recipes.md](references/recipes.md)). Fixed text uses common Traditional Chinese characters only.
- **Blank-able fields** (`blankProbability`) get a size: `display: inline-block; min-width: 6em; min-height: 1lh`, or sit in a table cell.
- **Tables**: `table-layout: fixed` with `<col>` widths (word.css sets the layout; you give the widths), one row per `{{#each}}` item, rows short enough never to exceed a page.
- **No text inside inline `<svg>`**; put it in an HTML mark beside the drawing.
- Don't upload, and don't edit files in the platform repo.
