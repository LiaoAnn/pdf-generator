# check-pack codes and their fixes

`check-pack` prints `file:line:column: code: message`; JSON issues end with `(at <json path>)`. Read the message first: it usually says exactly what to change. Section numbers refer to `$PDF_GENERATOR_REPO/packages/pack-spec/SPEC.md`.

| Code | Usual cause | Fix |
| --- | --- | --- |
| `zip-invalid` | The `.zip` is corrupt or not a zip | Check the folder instead, or re-zip it |
| `pack-too-large` | Over a size or file-count limit (§8) | Smaller images; a `{{#each}}` instead of copied rows |
| `pack-too-complex` | Nesting too deep to check (rules or template) | Flatten nested `object`/`array` fields and nested blocks |
| `path-invalid` | A file path with `..`, `./`, a leading `/`, a backslash | Plain relative `/`-separated paths |
| `manifest-missing` | No `manifest.json` at the root (zipped the folder, not its contents) | Put `manifest.json` at the pack root |
| `manifest-invalid` | A missing, misspelled or unknown key; an `id` not kebab-case | Copy the minimal example's manifest and edit values only (§1) |
| `json-syntax` | Trailing comma, comment, unquoted key | Strict JSON |
| `file-missing` | The manifest lists a file that isn't there | Fix the path or add the file |
| `file-unlisted` | A file in the pack the manifest doesn't list | List it in `files.assets` (or `styles`), or delete it (stray notes, drafts; `.DS_Store` and `__MACOSX/` are ignored) |
| `text-encoding` | A text file that isn't UTF-8 | Save as UTF-8 |
| `rules-invalid` | Unknown `type`, missing `min`/`max`/`lang`, `min > max`, a path in `of`/`part`/`whole` that names no numeric field | Compare with §2's table; paths go from the root with `[]` after arrays |
| `sample-invalid` | `sample.json` doesn't match the rules (length, range, check digit, `null` without `blankProbability`, missing or extra key) | Regenerate it with the engine (SKILL.md, step 4) after every rules change |
| `template-syntax` | Unclosed `{{#if}}`/`{{#each}}`, a stray `}}` | Balance the blocks |
| `template-unsupported` | `{{{raw}}}`, `{{> partial}}`, a helper other than `eq`, `lookup`, `number`, `rocDate` (`formatDate`, `add`, `inc`), a `rocDate` `format=` not in §3's list | Use the subset (§3); derive values in the rules, write fixed numbering as text |
| `template-unknown-field` | `{{field}}` that the rules don't define (typo, wrong scope inside `{{#each}}`: use `{{../x}}` or `@root.x`) | Match the rules' keys |
| `template-render` | Filling the sample failed (e.g. `{{#each}}` over a non-array, `rocDate` of a date before 1912 or of a non-date) | Fix the template or the rule type |
| `template-structure` | `{{…}}` inside a tag but outside a quoted value, in CSS, in a comment, after `<` | Put statements in text or quoted values; duplicate whole elements per branch (§3) |
| `html-active` | `<script>`, `on*=` handlers | Remove them; nothing runs |
| `html-unsupported` | An element or attribute outside the allowlist (`<form>`, `<button>`, `<select>`, `<iframe>`, `<canvas>`) | Use the look-alikes: text, borders, ☐ glyphs, tables |
| `asset-external` | A URL leaving the pack (`https://…`, a web font) | Put the file in the pack and reference it relatively, or use a platform font |
| `asset-path` | A root-relative (`/img.png`) or escaping (`../../x`) URL, an `@import` of a file outside the pack | Relative to the referring file, inside the pack |
| `asset-missing` | A referenced file that isn't in the pack | Add it and list it in `files.assets` |
| `asset-data` | A `data:` URL used as a stylesheet | Make it a real `.css` file listed in `files.styles` |
| `asset-dynamic` | A `src`/`href`/`srcset` or CSS URL built from data (`src="img/{{kind}}.png"`) | Write each path out and choose between them with `{{#if}}` |
| `css-escape` | A backslash escape in CSS (`content: "\25A1"`, `\5FAE`) | Write the character itself; files are UTF-8 |
| `css-page-box` | CSS that moves the page Paged.js lays out: any selector naming `pagedjs` (any case, quoted or escaped too: `[class*="pagedjs"]`, `.\70 agedjs_page`), or a nonzero `margin`/`padding`/`border`, a `position`, `transform` or `zoom` on `html`, `body`, `:root` or `*` (`body { padding: 20mm }` as page margins, a `* { margin: 2px }` reset) | Page margins on `@page`; `html, body { margin: 0; padding: 0 }`; spacing on your own elements (§5) |
| `font-unused` | An `@font-face` no printed element uses | Remove it; never declare the platform fonts |
| `gt-unmarked` | Text, an image, an input or a formula outside every `data-gt` (a stray `：`, a fixed caption, text between two spans) | Wrap it in its own mark, or move it into the neighbouring mark |
| `gt-nested` | A `data-gt` inside another `data-gt` | Split the outer into separate blocks, or drop the inner mark |
| `gt-type` | A block type not in §4's list (`text`, `value`, `header`) | Use `paragraph`, `field`, `page_header`, … |
| `gt-attribute` | Unknown `data-gt-*`, a detail attribute on the wrong type, a block statement in `data-gt-checked` | `data-gt-checked` only on `checkbox` (or cell boxes), with `true`/`false`/one `{{field}}` |
| `gt-id` | A `data-gt-id` with characters outside `A-Za-z0-9_-` or too long | Short ASCII ids, or none |
| `gt-branch` | An element opened in one `{{#if}}` branch and closed in another | Each element whole inside one branch |
| `gt-table` | `data-gt` on a `<td>`/`<tr>`, or `table` on a non-table | Mark only the `<table>`; cell boxes get `data-gt-checked` alone |
| `gt-checkbox` | A `checkbox` block with neither `data-gt-checked` nor exactly one input | Add `data-gt-checked="{{field}}"` |
| `gt-formula` | A `formula` block without LaTeX | Add `data-gt-latex` |
| `gt-image-text` | An `image` with `data-gt-text` that also contains printed text | Keep the text out of the image element |
