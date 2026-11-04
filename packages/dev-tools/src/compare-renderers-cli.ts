// Prints every gt.json block's ink share as pdf.js and PDFium each drew it,
// so renderer disagreements are found (Chromium prints a CSS repeating
// gradient as a shading pdf.js can't draw, T14-11):
//
//   node packages/dev-tools/src/compare-renderers-cli.ts <pdf> --gt <gt.json> [--out <dir>] [--scale <n>] [--threshold <n>]
//
// One line per block, `<id> p<page> pdf.js <share> PDFium <share> agree|DIFFERS`,
// then `blocks: <agreeing>/<total> agree`. With `--out`, also writes each
// page as both renderers drew it, `<name>-p<N>.pdfjs.png` and `.pdfium.png`.
// Exit 0 when every block agrees, 1 when any differs, 2 for usage and input
// errors.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gtSchema } from '@pdf-generator/contract';
import { compareRenderers } from './compare-renderers.ts';

const usage =
  'usage: node packages/dev-tools/src/compare-renderers-cli.ts <pdf> --gt <gt.json> [--out <dir>] [--scale <n>] [--threshold <n>]';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gt: { type: 'string' },
      out: { type: 'string' },
      scale: { type: 'string' },
      threshold: { type: 'string' },
    },
  });
  const [input] = positionals;
  if (!input || positionals.length > 1 || values.gt === undefined)
    throw new Error(usage);
  const scale = values.scale === undefined ? undefined : Number(values.scale);
  if (scale !== undefined && !(scale > 0))
    throw new Error(`--scale must be a positive number, not ${values.scale}`);
  const threshold =
    values.threshold === undefined ? undefined : Number(values.threshold);
  if (threshold !== undefined && !(threshold >= 0))
    throw new Error(
      `--threshold must be a non-negative number, not ${values.threshold}`,
    );
  const gt = gtSchema.parse(JSON.parse(await readFile(values.gt, 'utf8')));
  const result = await compareRenderers(await readFile(input), gt, {
    scale,
    threshold,
  });
  for (const block of result.blocks) {
    console.log(
      `${block.id} p${block.page} pdf.js ${block.pdfjs.toFixed(2)} PDFium ${block.pdfium.toFixed(2)} ${block.agree ? 'agree' : 'DIFFERS'}`,
    );
  }
  console.log(
    `blocks: ${result.blocks.filter(block => block.agree).length}/${result.blocks.length} agree`,
  );
  if (values.out !== undefined) {
    await mkdir(values.out, { recursive: true });
    const name = basename(input).replace(/\.pdf$/i, '');
    for (const [index, page] of result.pages.entries()) {
      await writeFile(
        join(values.out, `${name}-p${index + 1}.pdfjs.png`),
        page.pdfjs,
      );
      await writeFile(
        join(values.out, `${name}-p${index + 1}.pdfium.png`),
        page.pdfium,
      );
    }
  }
  process.exitCode = result.blocks.every(block => block.agree) ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.includes(usage) ? message : `${message}\n${usage}`);
  process.exit(2);
}
