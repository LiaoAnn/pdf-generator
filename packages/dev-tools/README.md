# @pdf-generator/dev-tools

Tools for working on the platform and on template packs. Nothing in the product imports this package.

## pdf-to-png

The T3 preview browser downloads a PDF instead of showing it. `pdf-to-png` draws each page as a PNG with pdf.js (unpdf's build, the one `packages/self-check` reads PDFs with) in the container's Playwright Chromium, and can draw a gt.json's boxes over the pages, so you can see whether the ground truth sits on what was printed. Run it in your stack, from the repo root:

```bash
pnpm pdf-to-png <pdf> [--gt <gt.json>] [--out <dir>] [--scale <n>]
# the same: node packages/dev-tools/src/cli.ts <pdf> …
```

- Writes `<dir>/<name>-p<N>.png` for page N (from 1) and prints each path. `--out` defaults to the PDF's folder: keep output outside the worktree (the container's `/tmp`) or under `.wrangler/`, since Biome lints every other file in it.
- `--scale` is pixels per PDF point (default 2; A4 is then about 1190 × 1684 px).
- `--gt` validates the file with the contract's `gtSchema`, then draws on page N every block with `page` N: its bbox outlined in a colour per block type, with its `order` and `id` above it (inside the box when it starts at the top of the page). Table cells are outlined in orange and cell checkboxes in cyan. The outlines are 2 px wide, the pixel before and the one at each edge. Boxes are placed at gt.json's points × scale, without correcting for the PDF's MediaBox being slightly off the declared page size (Chrome prints A4 as 594.96 × 841.92 pt).

To look at the PNGs, read them with an agent's image reader (Claude Code's Read tool shows images). From code:

```ts
import { pdfToPng } from '@pdf-generator/dev-tools';

const pngs = await pdfToPng(pdfBytes, { scale: 2, gt }); // one PNG's bytes per page
```

PDFs that rely on fonts they don't embed (the platform's prints embed theirs) may render with substitute glyphs: pdf.js gets no standard fonts or CMaps here.
