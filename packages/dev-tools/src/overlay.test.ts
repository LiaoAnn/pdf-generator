import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { pdfToPng } from './index.ts';

type Box = [number, number, number, number];
let browser: Browser;
let directory: string;
let pdf: Uint8Array;
let input: string;

// Deliberately not the exact 240 x 360 pt MediaBox: GT coordinates must
// be multiplied by scale, never fitted to the declared GT page dimensions.
const gt: GroundTruth = gtSchema.parse({
  schemaVersion: 1,
  source: { templateId: 'overlay', templateVersion: 1, seed: 'test', index: 0 },
  pages: [
    { width: 241, height: 361 },
    { width: 241, height: 361 },
  ],
  blocks: [
    {
      id: 'top',
      type: 'title',
      page: 1,
      bbox: [16, 4, 160, 28],
      order: 0,
      text: 'First page',
    },
    {
      id: 'grid',
      type: 'table',
      page: 1,
      bbox: [24, 80, 192, 176],
      order: 1,
      text: 'Item Yes',
      table: {
        rows: 1,
        cols: 2,
        cells: [
          {
            row: 0,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            header: false,
            text: 'Item',
            bbox: [32, 96, 96, 152],
          },
          {
            row: 0,
            col: 1,
            rowSpan: 1,
            colSpan: 1,
            header: false,
            text: 'Yes',
            bbox: [112, 96, 176, 152],
            checkboxes: [
              { checked: true, text: 'Yes', bbox: [128, 120, 144, 136] },
            ],
          },
        ],
      },
    },
    {
      id: 'heading',
      type: 'heading',
      page: 2,
      bbox: [80, 40, 200, 72],
      order: 2,
      text: 'Second page',
    },
    {
      id: 'body',
      type: 'paragraph',
      page: 2,
      bbox: [48, 208, 184, 256],
      order: 3,
      text: 'Printed content',
    },
  ],
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pdf-overlay-test-'));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>
      @page { margin: 0; }
      body { margin: 0; font: 10pt sans-serif; }
      section { position: relative; height: 300pt; }
      section + section { break-before: page; }
      span { position: absolute; }
    </style>
    <section><span style="left:24pt;top:16pt">First page</span>
      <span style="left:40pt;top:112pt">Item</span>
      <span style="left:148pt;top:124pt">Yes</span></section>
    <section><span style="left:88pt;top:56pt">Second page</span>
      <span style="left:56pt;top:224pt">Printed content</span></section>`);
    pdf = await page.pdf({
      width: '320px',
      height: '480px',
      printBackground: true,
    });
  } finally {
    await page.close();
  }
  input = join(directory, 'printed report.pdf');
  await writeFile(input, pdf);
});

afterAll(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./cli.ts', import.meta.url)), ...args],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', text => {
        stdout += text;
      });
      child.stderr.setEncoding('utf8').on('data', text => {
        stderr += text;
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    },
  );
}

async function inspectOverlay(
  plain: Uint8Array[],
  overlay: Uint8Array[],
  scale: number,
) {
  expect(overlay).toHaveLength(2);
  const page = await browser.newPage();
  try {
    for (let index = 0; index < 2; index++) {
      const blocks = gt.blocks.filter(block => block.page === index + 1);
      const boxes: Box[] = blocks.flatMap(block => [
        block.bbox,
        ...(block.type === 'table'
          ? block.table.cells.flatMap(cell => [
              cell.bbox,
              ...(cell.checkboxes?.map(checkbox => checkbox.bbox) ?? []),
            ])
          : []),
      ]);
      const result = await page.evaluate(
        async ({ plain, overlay, boxes, labels, scale }) => {
          async function decode(base64: string) {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('2D canvas unavailable');
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height);
          }
          const before = await decode(plain);
          const after = await decode(overlay);
          const scaled = boxes.map(box => box.map(value => value * scale));
          const strips = labels.map(([x = 0, y = 0]) => [
            x * scale,
            y * scale < 14 ? y * scale : y * scale - 14,
          ]);
          const pixel = (x: number, y: number) =>
            Array.from(
              after.data.slice(
                (y * after.width + x) * 4,
                (y * after.width + x) * 4 + 4,
              ),
            );
          const edges = scaled.flatMap(([x0 = 0, y0 = 0, x1 = 0, y1 = 0]) => {
            const mx = Math.floor((x0 + x1) / 2);
            const my = Math.floor((y0 + y1) / 2);
            // Both sides of each edge: catches a filled box, a one-sided stroke,
            // missing table details, bottom-left origin, and scale corrections.
            return [
              [x0 - 1, my],
              [x0, my],
              [x1 - 1, my],
              [x1, my],
              [mx, y0 - 1],
              [mx, y0],
              [mx, y1 - 1],
              [mx, y1],
            ].map(([x = 0, y = 0]) => ({
              x,
              y,
              rgba: pixel(Math.floor(x), Math.floor(y)),
            }));
          });
          let unexpectedChanges = 0;
          let printedPixels = 0;
          const labelChanges = strips.map(() => 0);
          for (let y = 0; y < before.height; y++) {
            for (let x = 0; x < before.width; x++) {
              const offset = (y * before.width + x) * 4;
              const nearEdge = scaled.some(
                ([x0 = 0, y0 = 0, x1 = 0, y1 = 0]) =>
                  ((Math.abs(x - x0) <= 2 || Math.abs(x - x1) <= 2) &&
                    y >= y0 - 2 &&
                    y <= y1 + 2) ||
                  ((Math.abs(y - y0) <= 2 || Math.abs(y - y1) <= 2) &&
                    x >= x0 - 2 &&
                    x <= x1 + 2),
              );
              const strip = strips.findIndex(
                ([left = 0, top = 0]) => x >= left && y >= top && y < top + 14,
              );
              const changed = [0, 1, 2, 3].some(
                channel =>
                  before.data[offset + channel] !==
                  after.data[offset + channel],
              );
              if (strip >= 0 && changed && !nearEdge)
                labelChanges[strip] = (labelChanges[strip] ?? 0) + 1;
              if (nearEdge || strip >= 0) continue;
              if (changed) unexpectedChanges++;
              if ((before.data[offset] ?? 255) < 128) printedPixels++;
            }
          }
          return {
            edges,
            unexpectedChanges,
            printedPixels,
            labelChanges,
            dimensions: [
              after.width,
              after.height,
              before.width,
              before.height,
            ],
          };
        },
        {
          plain: Buffer.from(plain[index] ?? []).toString('base64'),
          overlay: Buffer.from(overlay[index] ?? []).toString('base64'),
          boxes,
          labels: blocks.map(block => [block.bbox[0], block.bbox[1]]),
          scale,
        },
      );
      expect(result.dimensions).toEqual([
        240 * scale,
        360 * scale,
        240 * scale,
        360 * scale,
      ]);
      const uncolouredEdges = result.edges.filter(({ rgba }) => {
        const [r = 0, g = 0, b = 0, alpha] = rgba;
        return (
          alpha !== 255 ||
          Math.max(r, g, b) - Math.min(r, g, b) <= 100 ||
          new Set([r, g, b]).size !== 3
        );
      });
      expect
        .soft(
          uncolouredEdges.slice(0, 4),
          `page ${index + 1}: expected opaque saturated outlines on both sides of every edge`,
        )
        .toEqual([]);
      expect(
        result.unexpectedChanges,
        `page ${index + 1}: pixels outside edges and 14px label strips (including the other page's boxes)`,
      ).toBe(0);
      expect(
        result.printedPixels,
        'fixture must contain printed text outside overlay regions',
      ).toBeGreaterThan(20);
      for (const count of result.labelChanges)
        expect
          .soft(count, 'each block needs a visible label in its own strip')
          .toBeGreaterThan(5);
    }
  } finally {
    await page.close();
  }
}

test('CLI --gt overlays every page, table cell and checkbox without changing printed content or output paths', async () => {
  const gtPath = join(directory, 'valid.gt.json');
  const output = join(directory, 'cli-output');
  await writeFile(gtPath, JSON.stringify(gt));
  const result = await runCli([
    input,
    '--gt',
    gtPath,
    '--out',
    output,
    '--scale',
    '2',
  ]);
  expect(result.code, result.stderr).toBe(0);
  const paths = [1, 2].map(number =>
    join(output, `printed report-p${number}.png`),
  );
  expect(result.stdout.trim().split(/\r?\n/)).toEqual(paths);
  expect((await readdir(output)).sort()).toEqual(
    paths.map(path => path.split('/').at(-1)),
  );
  await inspectOverlay(
    await pdfToPng(pdf, { scale: 2 }),
    await Promise.all(paths.map(path => readFile(path))),
    2,
  );
});

test('public library scales GT coordinates directly at fractional scale and keeps strokes and labels in pixel units', async () => {
  await inspectOverlay(
    await pdfToPng(pdf, { scale: 1.25 }),
    await pdfToPng(pdf, { scale: 1.25, gt }),
    1.25,
  );
});

test('block labels visibly include both id and order, including a box near the page top', async () => {
  const renamed = gtSchema.parse({
    ...gt,
    blocks: gt.blocks.map(block => ({ ...block, id: `${block.id}_renamed` })),
  });
  const reordered = gtSchema.parse({
    ...gt,
    blocks: gt.blocks.map(block => ({
      ...block,
      order: (block.order + 1) % gt.blocks.length,
    })),
  });
  const renders = [];
  for (const groundTruth of [gt, renamed, reordered]) {
    const pngs = await pdfToPng(pdf, { scale: 2, gt: groundTruth });
    renders.push(pngs.map(png => Buffer.from(png).toString('base64')));
  }
  const page = await browser.newPage();
  try {
    const differences = await page.evaluate(
      async ({ renders, blocks }) => {
        const decoded: ImageData[][] = [];
        for (const pages of renders) {
          const images = [];
          for (const base64 of pages) {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('2D canvas unavailable');
            context.drawImage(image, 0, 0);
            images.push(
              context.getImageData(0, 0, canvas.width, canvas.height),
            );
          }
          decoded.push(images);
        }
        return blocks.map(block => {
          const base = decoded[0]?.[block.page - 1];
          if (!base) throw new Error('missing baseline page');
          const left = block.bbox[0] * 2;
          const top = block.bbox[1] * 2;
          const stripTop = top < 14 ? top : top - 14;
          return [1, 2].map(variant => {
            const image = decoded[variant]?.[block.page - 1];
            if (!image) throw new Error('missing variant page');
            let changed = 0;
            // Exclude the box stroke itself; a colour change isn't label text.
            for (let y = stripTop + 2; y < stripTop + 12; y++) {
              for (let x = left + 3; x < base.width; x++) {
                const offset = (y * base.width + x) * 4;
                if (
                  [0, 1, 2].some(
                    channel =>
                      base.data[offset + channel] !==
                      image.data[offset + channel],
                  )
                )
                  changed++;
              }
            }
            return changed;
          });
        });
      },
      { renders, blocks: gt.blocks },
    );
    for (const [index, counts] of differences.entries()) {
      expect(
        counts[0],
        `${gt.blocks[index]?.id}: changing id must change its label`,
      ).toBeGreaterThan(5);
      expect(
        counts[1],
        `${gt.blocks[index]?.id}: changing order must change its label`,
      ).toBeGreaterThan(5);
    }
  } finally {
    await page.close();
  }
});

test.each(['missing', 'not JSON', 'invalid schema'] as const)(
  'CLI rejects a %s --gt file before writing any PNG, with a relevant diagnostic',
  async kind => {
    const output = await mkdtemp(join(directory, 'bad-gt-'));
    const gtPath = join(output, 'broken.gt.json');
    if (kind === 'not JSON') await writeFile(gtPath, '{not JSON');
    // Valid JSON with every other required field present: must invoke gtSchema.
    if (kind === 'invalid schema')
      await writeFile(
        gtPath,
        JSON.stringify({ ...gt, blocks: [{ ...gt.blocks[0], page: 3 }] }),
      );
    const result = await runCli([input, '--gt', gtPath, '--out', output]);
    expect(result.code).not.toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(
      (await readdir(output)).filter(name => name.endsWith('.png')),
    ).toEqual([]);
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.stderr).toMatch(
      kind === 'missing'
        ? /ENOENT|no such file|not found/i
        : kind === 'not JSON'
          ? /JSON|Unexpected|parse/i
          : /page|schema|valid|block/i,
    );
  },
);
