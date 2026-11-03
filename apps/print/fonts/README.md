# apps/print/fonts

These are the font build's patched whole platform fonts, not served
(T07-37): wrangler's build command (`src/fonts/chunks.ts`) splits them into
their gitignored unicode-range chunks in public/fonts before `wrangler dev`,
`wrangler deploy` and the tests, and they are still the input of the tests
(`src/test-fixtures/whole-fonts.ts`).
