# Template pack acceptance fixtures

`valid/` is a small Taiwanese company monthly report with synthetic sample data.
`broken/NN-slug/pack/` contains a full copy with exactly one deliberate mistake.
Each sibling `expected.json` records the mistake and exact source locations (1-based).
Locations are derived from fixture source; diagnostic messages are intentionally not pinned.
Image and font assets are tiny local placeholders; the font is not a downloaded font.
