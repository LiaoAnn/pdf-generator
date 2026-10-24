# minimal-example

The smallest template pack that follows [the pack spec](../../packages/pack-spec/SPEC.md): a one-page A4 meeting record (會議紀錄) laid out with the Word-style `word.css`, showing each common `data-gt` mark, including checkboxes inside a table cell. Copy this folder to start a new pack.

- `pack/`: the pack itself, the files that go into the upload zip (`manifest.json` at the zip root).
- `pack/styles/word.css`: a copy of `packages/pack-spec/word.css`; a test keeps it identical.
- `src/`: `packFiles()` and `packZip()`, and the tests that run `checkPack` and the contract on the pack.
- `src/word-reference.ts`: the Word-equivalent reference for the side-by-side check (SPEC.md §7): the same record as a `.docx` with Word's settings.

Check it: `pnpm --filter @pdf-generator/minimal-example check-pack` (prints `ok: minimal-example`).

Compare it with Word (in the dev container, with LibreOffice and the platform fonts installed):

```sh
node src/word-reference.ts /tmp/reference.docx          # the sample record
soffice --headless --convert-to pdf --outdir /tmp /tmp/reference.docx
```

Then print the pack (the web app's preview of an uploaded version) and put the two PDFs side by side.
