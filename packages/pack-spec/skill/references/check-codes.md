# check-pack codes and their fixes

`check-pack` prints `file:line:column: code: message`; JSON issues end with `(at <json path>)`. A code marked "web upload only" never comes from `check-pack`: the platform's upload refuses such a zip before checking, so `check-pack` passing doesn't mean the upload passes the §8 limits. Read the message first: it usually says exactly what to change. Section numbers refer to `$PDF_GENERATOR_REPO/packages/pack-spec/SPEC.md`.

| Code | Usual cause | Fix |
| --- | --- | --- |
| `zip-invalid` | The `.zip` is corrupt or not a zip; web upload only: an entry holding more data than its header says, or in the data but not the directory | Check the folder instead, or re-zip it |
| `zip-duplicate-name` | Web upload only: a name twice in the zip | Re-zip a clean folder |
| `zip-too-many-blocks` | Web upload only: a zip entry in more deflate blocks than its data pays for | Re-zip it with a normal zip tool |
| `pack-too-large` | The pack unzipped over the total size limit: 20 MiB on upload (§8); `check-pack` alone allows 100 MiB | Smaller images; a `{{#each}}` instead of copied rows |
| `pack-too-many-files` | Web upload only: over 200 files, or over 1000 zip entries (§8) | Fewer files: merge stylesheets, drop unused assets; re-zip without junk entries |
| `file-too-large` | Web upload only: one file over 16 MiB, or one text file over 64 KiB (§8) | Smaller images; a `{{#each}}` instead of copied rows |
| `pack-text-too-large` | Web upload only: the text files over 256 KiB together (§8) | A `{{#each}}` over rows, not copied rows |
| `pack-check-failed` | Web upload only: `checkPack` itself threw on this pack (a platform fault, not a rule you broke); the message carries the error | Report the zip to the platform maintainers; meanwhile change whatever unusual construct the message points at |
| `pack-too-complex` | Nesting too deep to check (rules or template; `data:image/svg+xml` images more than 8 deep) | Flatten nested `object`/`array` fields and nested blocks; draw a nested SVG image's shapes in the image around it |
| `path-invalid` | A file path with `..`, `./`, a leading `/`, a backslash | Plain relative `/`-separated paths |
| `manifest-missing` | No `manifest.json` at the root (zipped the folder, not its contents) | Put `manifest.json` at the pack root |
| `manifest-invalid` | A missing, misspelled or unknown key; an `id` not kebab-case | Copy the minimal example's manifest and edit values only (§1) |
| `json-syntax` | Trailing comma, comment, unquoted key | Strict JSON |
| `file-missing` | The manifest lists a file that isn't there | Fix the path or add the file |
| `file-unlisted` | A file in the pack the manifest doesn't list | List it in `files.assets` (or `styles`), or delete it (stray notes, drafts; `.DS_Store` and `__MACOSX/` are ignored) |
| `text-encoding` | A text file that isn't UTF-8; an `.svg` file or `data:image/svg+xml` image with a NUL, a non-UTF-8 `encoding` declaration or `charset` | Save as UTF-8 |
| `rules-invalid` | Unknown `type`, missing `min`/`max`/`lang`, `min > max`, a path in `of`/`part`/`whole` that names no numeric field | Compare with §2's table; paths go from the root with `[]` after arrays |
| `sample-invalid` | `sample.json` doesn't match the rules (length, range, check digit, `null` without `blankProbability`, missing or extra key) | Regenerate it with the engine (SKILL.md, step 4) after every rules change |
| `template-doctype` | No `<!doctype html>` at the very start: missing, a legacy (HTML 4) doctype, or something before it, even a no-break space or a `{{#if}}` | Make `<!doctype html>` the template's first line; only blank lines and comments may come before it (§3) |
| `template-syntax` | Unclosed `{{#if}}`/`{{#each}}`, a stray `}}` | Balance the blocks |
| `template-unsupported` | `{{{raw}}}`, `{{> partial}}`, a helper other than `eq`, `lookup`, `number`, `rocDate` (`formatDate`, `add`, `inc`), a `rocDate` `format=` not in §3's list | Use the subset (§3); derive values in the rules, write fixed numbering as text |
| `template-unknown-field` | `{{field}}` that the rules don't define (typo, wrong scope inside `{{#each}}`: use `{{../x}}` or `@root.x`) | Match the rules' keys |
| `template-render` | Filling the sample failed (e.g. `{{#each}}` over a non-array, `rocDate` of a date before 1912 or of a non-date) | Fix the template or the rule type |
| `template-structure` | `{{…}}` inside a tag but outside a quoted value, in CSS, in a comment, after `<`; no `</head>`, or one inside a block | Put statements in text or quoted values; duplicate whole elements per branch (§3) |
| `html-active` | `<script>`, `on*=` handlers | Remove them; nothing runs |
| `html-unsupported` | An element or attribute outside the allowlist (`<form>`, `<button>`, `<select>`, `<iframe>`, `<canvas>`); a DOCTYPE internal subset (`[…]`) in an SVG file or `data:` image | Use the look-alikes: text, borders, ☐ glyphs, tables |
| `asset-external` | A URL leaving the pack (`https://…`, a web font) | Put the file in the pack and reference it relatively, or use a platform font |
| `asset-path` | A root-relative (`/img.png`) or escaping (`../../x`) URL, an `@import` of a file outside the pack | Relative to the referring file, inside the pack |
| `asset-missing` | A referenced file that isn't in the pack | Add it and list it in `files.assets` |
| `asset-data` | A `data:` URL used as a stylesheet, also inside an SVG image (`<?xml-stylesheet?>`, `@import`, `<link>`) | Make it a real `.css` file listed in `files.styles`; inside an SVG, put its rules in the SVG's `<style>` (an SVG image loads no pack file) |
| `asset-dynamic` | A `src`/`href`/`srcset` or CSS URL built from data (`src="img/{{kind}}.png"`) | Write each path out and choose between them with `{{#if}}` |
| `asset-stylesheet-type` | A `<link rel="stylesheet">` or `@import` pointing to an image or font file (`.png`, `.jpg`, `.woff2`, `.ttf`, …) | Keep stylesheets in `.css` files and point to those |
| `css-escape` | A backslash escape in CSS (`content: "\25A1"`, `\5FAE`) | Write the character itself; files are UTF-8 |
| `css-import-cycle` | Stylesheets that `@import` each other in a loop (`a.css` → `b.css` → `a.css`) | Break the loop: import each sheet from one place only, or merge the sheets |
| `css-import-expansion` | `@import`s that add up to more than 64 stylesheet loads or 1 MiB of CSS (a sheet imported twice by each of several others), or a stylesheet `<link>` inside `{{#each}}` | Import each sheet once, or merge the sheets; move the `<link>` out of the `{{#each}}` |
| `css-page-box` | CSS that moves the page Paged.js lays out: any selector naming `pagedjs` (any case, quoted or escaped too: `[class*="pagedjs"]`, `.\70 agedjs_page`), or a nonzero `margin`/`padding`/`border`, a `position`, `transform` or `zoom` on `html`, `body`, `:root` or `*` (`body { padding: 20mm }` as page margins, a `* { margin: 2px }` reset) | Page margins on `@page`; `html, body { margin: 0; padding: 0 }`; spacing on your own elements (§5) |
| `css-repeating-gradient` | A `repeating-linear-gradient()` or `repeating-radial-gradient()` anywhere in the CSS (any case, a `-webkit-` prefix, escapes, in a `style` attribute), or an SVG `<linearGradient>`/`<radialGradient>` with `spreadMethod="repeat"`/`"reflect"` (or SMIL `<set>` of it); also inside `.svg` files and `data:image/svg+xml` images | Stripes as SVG `<rect>`s and rings as `<circle>`s, or a tiled `linear-gradient(90deg, #000 50%, transparent 50%) 0 0 / 4pt 100%` (tiles in pt); not a conic gradient either (§5) |
| `font-unused` | An `@font-face` no printed element uses: its family is unused, or its bold/italic face is never asked for | Remove it; never declare the platform fonts |
| `gt-unmarked` | Text, an image, an input or a formula outside every `data-gt` (a stray `：`, a fixed caption, text between two spans) | Wrap it in its own mark, or move it into the neighbouring mark |
| `gt-nested` | A `data-gt` inside another `data-gt` | Split the outer into separate blocks, or drop the inner mark |
| `gt-type` | A block type not in §4's list (`text`, `value`, `header`) | Use `paragraph`, `field`, `page_header`, … |
| `gt-attribute` | Unknown `data-gt-*`, a detail attribute on the wrong type, a block statement in `data-gt-checked` | `data-gt-checked` only on `checkbox` (or cell boxes), with `true`/`false`/one `{{field}}` |
| `gt-id` | A `data-gt-id` with characters outside `A-Za-z0-9_-` or too long | Short ASCII ids, or none |
| `gt-branch` | An element opened in one `{{#if}}` branch and closed in another | Each element whole inside one branch |
| `gt-table` | `data-gt` on a `<td>`/`<tr>`, `table` on a non-table, or `data-gt-checked` in a table nested inside a cell | Mark only the `<table>`; cell boxes get `data-gt-checked` alone |
| `gt-checkbox` | A `checkbox` block with neither `data-gt-checked` nor exactly one input in every branch, or a literal `data-gt-checked` that disagrees with an input's `checked` | Add `data-gt-checked="{{field}}"` |
| `gt-formula` | A `formula` block without `data-gt-latex` or exactly one x-tex annotation in every branch | Add `data-gt-latex` |
| `gt-image-text` | An `image` with `data-gt-text` that also contains printed text | Keep the text out of the image element |
