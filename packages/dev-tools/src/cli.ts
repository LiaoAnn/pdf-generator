// Writes each page of a PDF as <name>-p<N>.png and prints the paths:
//
//   node packages/dev-tools/src/cli.ts <pdf> [--out <dir>] [--scale <n>]
//
// --out defaults to the PDF's folder; --scale is pixels per PDF point
// (default 2).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gtSchema } from '@pdf-generator/contract';
import { pdfToPng } from './pdf-to-png.ts';

const usage =
  'usage: node packages/dev-tools/src/cli.ts <pdf> [--gt <gt.json>] [--out <dir>] [--scale <n>]';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gt: { type: 'string' },
      out: { type: 'string' },
      scale: { type: 'string' },
    },
  });
  const [input] = positionals;
  if (!input || positionals.length > 1) throw new Error(usage);
  const scale = values.scale === undefined ? undefined : Number(values.scale);
  if (scale !== undefined && !(scale > 0))
    throw new Error(`--scale must be a positive number, not ${values.scale}`);
  const gt =
    values.gt === undefined
      ? undefined
      : gtSchema.parse(JSON.parse(await readFile(values.gt, 'utf8')));
  const pngs = await pdfToPng(await readFile(input), { scale, gt });
  const out = values.out ?? dirname(input);
  await mkdir(out, { recursive: true });
  const name = basename(input).replace(/\.pdf$/i, '');
  for (const [index, png] of pngs.entries()) {
    const path = join(out, `${name}-p${index + 1}.png`);
    await writeFile(path, png);
    console.log(path);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
