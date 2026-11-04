import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { compareRenderers } from './index.ts';

// Blocks at known CSS positions in points, so the gt.json boxes don't come
// from either renderer under test. Page 1 holds four blocks; page 2 has one
// block where page 1 is blank, so a block measured on the wrong page fails.
const blocks = {
  solid: [20, 20, 60, 40],
  empty: [80, 20, 120, 40],
  'left-half': [140, 20, 180, 40],
  // Chromium prints a CSS repeating gradient as a function-based shading
  // that pdf.js samples once per period (T14-11): PDFium shows the stripes.
  stripes: [20, 55, 95, 85],
  'page-two': [80, 20, 120, 40],
} as const;

let pdf: Uint8Array;

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const at = ([x0, y0, x1, y1]: readonly number[]) =>
      `left:${x0}pt;top:${y0}pt;width:${(x1 ?? 0) - (x0 ?? 0)}pt;height:${(y1 ?? 0) - (y0 ?? 0)}pt`;
    await page.setContent(`<!doctype html><style>
      @page { size: 200pt 100pt; margin: 0 }
      body { margin: 0 }
      section { position: relative; height: 100pt; overflow: hidden }
      section + section { break-before: page }
      i { position: absolute; display: block; print-color-adjust: exact }
    </style>
    <section>
      <i style="${at(blocks.solid)};background:black"></i>
      <i style="${at([140, 20, 160, 40])};background:black"></i>
      <i style="${at(blocks.stripes)};background:repeating-linear-gradient(90deg, black 0 2pt, transparent 2pt 4pt)"></i>
    </section>
    <section><i style="${at(blocks['page-two'])};background:black"></i></section>`);
    pdf = new Uint8Array(
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
  } finally {
    await browser.close();
  }
});

function gt(): GroundTruth {
  return gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'compare-renderers',
      templateVersion: 1,
      seed: 'T14-11',
      index: 0,
    },
    pages: [
      { width: 200, height: 100 },
      { width: 200, height: 100 },
    ],
    blocks: Object.entries(blocks).map(([id, bbox], order) => ({
      id,
      type: 'image',
      page: id === 'page-two' ? 2 : 1,
      order,
      text: '',
      bbox,
    })),
  });
}

test('measures each block in both renderers and flags where they disagree', async () => {
  const { blocks: measured } = await compareRenderers(pdf, gt());
  const byId = Object.fromEntries(measured.map(block => [block.id, block]));
  expect(measured.map(({ id, page }) => [id, page])).toEqual([
    ['solid', 1],
    ['empty', 1],
    ['left-half', 1],
    ['stripes', 1],
    ['page-two', 2],
  ]);
  for (const id of ['solid', 'page-two']) {
    expect(byId[id]?.pdfjs).toBeGreaterThan(0.95);
    expect(byId[id]?.pdfium).toBeGreaterThan(0.95);
    expect(byId[id]?.agree).toBe(true);
  }
  expect(byId.empty).toMatchObject({ pdfjs: 0, pdfium: 0, agree: true });
  for (const renderer of ['pdfjs', 'pdfium'] as const) {
    expect(byId['left-half']?.[renderer]).toBeGreaterThan(0.45);
    expect(byId['left-half']?.[renderer]).toBeLessThan(0.55);
  }
  expect(byId['left-half']?.agree).toBe(true);
  // PDFium draws the 2-of-4 pt stripes; pdf.js draws them solid or blank.
  expect(byId.stripes?.pdfium).toBeGreaterThan(0.4);
  expect(byId.stripes?.pdfium).toBeLessThan(0.6);
  expect(
    Math.abs((byId.stripes?.pdfjs ?? 0) - (byId.stripes?.pdfium ?? 0)),
  ).toBeGreaterThan(0.3);
  expect(byId.stripes?.agree).toBe(false);
});

test('agreement uses the given threshold on the ink shares', async () => {
  const { blocks: measured } = await compareRenderers(pdf, gt(), {
    threshold: 1,
  });
  expect(measured.every(block => block.agree)).toBe(true);
});

test('returns each page drawn by both renderers as PNGs at the scale', async () => {
  const scale = 3;
  const { pages } = await compareRenderers(pdf, gt(), { scale });
  expect(pages).toHaveLength(2);
  for (const page of pages) {
    for (const png of [page.pdfjs, page.pdfium]) {
      const bytes = Buffer.from(png);
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(
        Math.abs(bytes.readUInt32BE(16) - 200 * scale),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(bytes.readUInt32BE(20) - 100 * scale),
      ).toBeLessThanOrEqual(1);
    }
  }
});
