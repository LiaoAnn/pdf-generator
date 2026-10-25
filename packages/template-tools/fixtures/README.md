# Template pack acceptance fixtures

`valid/` is a small Taiwanese company monthly report with synthetic sample data.
`broken/NN-slug/pack/` contains a full copy with exactly one deliberate mistake.
Each sibling `expected.json` records the mistake and exact source locations (1-based).
Locations are derived from fixture source; diagnostic messages are intentionally not pinned.
The image is a tiny local placeholder. The broken packs' `assets/report.woff2` is a 27-byte placeholder too (the corpus test lets it differ from the valid pack's).

`valid/assets/report.woff2` is a real font, so a batch of the valid pack prints in its own font: LXGW WenKai TC 1.530 Regular (`apps/print/public/fonts/LXGWWenKaiTC-Regular.ttf`, SIL OFL 1.1, `LICENSE-lxgw.txt`), subset with `subset-font` 2 (harfbuzz) to woff2. The subset covers every character the pack's rules can generate, not just the sample's: printable ASCII, `／：`, every character of the pack's template, rules and sample, and every non-ASCII character in `packages/fake-data/src/*.ts` and `src/taiwan/*.ts` (tests excluded), which hold the generators' word lists. `src/fixtures.test.ts` checks the coverage over 2,500 generated records. Rebuild it the same way when the rules or the fake-data word lists change.
