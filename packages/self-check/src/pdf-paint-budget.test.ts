import { gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { checkPdf } from './index.ts';
import { maxPaints } from './paints.ts';
import {
  type PdfDocument,
  type PdfPage,
  type PdfPaint,
  readPdf,
} from './pdf.ts';

// Independent fixture sizes: changing the policy constant must not silently
// shrink the attack along with it. Total: 33,385 separately painted rectangles.
const counts = [1, 16_384, 17_000];
let overflowPdf: Uint8Array;
let overflow: PdfDocument;
let below: PdfDocument;

async function print(counts: number[]) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      @page { size: 100pt 100pt; margin: 0 }
      body { margin: 0 }
      section { height: 100pt; break-after: page }
      section:last-child { break-after: auto }
      svg { display: block; width: 100pt; height: 100pt }
    </style>${counts
      .map(count => {
        // Alternating almost-black fills prevent Chromium from coalescing paths.
        const pair =
          '<rect width="50" height="50" fill="#000000"/><rect width="50" height="50" fill="#000001"/>';
        return `<section><svg viewBox="0 0 100 100">${pair.repeat(Math.floor(count / 2))}${count % 2 ? '<rect width="50" height="50"/>' : ''}</svg></section>`;
      })
      .join('')}`);
    return await page.pdf({ preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

// Count retained records, including paints reached through masks, group masks
// and tiles. A shared mask/tile record occupies memory only once.
function retained(document: PdfDocument) {
  const seen = new Set<PdfPaint>();
  const visit = (paints: PdfPaint[]) => {
    for (const paint of paints) {
      if (seen.has(paint)) continue;
      seen.add(paint);
      visit(paint.mask?.paints ?? []);
      visit(paint.tile?.paints ?? []);
      for (const group of paint.groups ?? []) visit(group.mask?.paints ?? []);
    }
  };
  for (const page of document.pages) visit(page.paints);
  return seen.size;
}

function pageFallbacks(page: PdfPage) {
  return page.paints.filter(
    paint =>
      paint.unmeasured &&
      paint.box[0] === 0 &&
      paint.box[1] === 0 &&
      paint.box[2] === page.width &&
      paint.box[3] === page.height,
  );
}

beforeAll(async () => {
  overflowPdf = await print(counts);
  overflow = await readPdf(overflowPdf);
  below = await readPdf(await print([1_293]));
  // Fixture guard independent of paint retention: Chromium really emitted one
  // painted path per element, rather than flattening this into one raster.
  expect(
    overflow.pages.map(
      page => page.marks.filter(mark => mark.kind === 'path').length,
    ),
  ).toEqual(counts);
  expect(overflow.pages.flatMap(page => page.items)).toEqual([]);
  expect(
    below.pages[0]?.marks.filter(mark => mark.kind === 'path'),
  ).toHaveLength(1_293);
});

test('overlapping Chromium paths cannot retain unbounded paint records or reset the cap at each page', () => {
  expect(maxPaints).toBe(32_768);
  expect(retained(overflow)).toBeLessThanOrEqual(
    maxPaints + overflow.pages.length,
  );
});

test('dropping paints marks only the exhausted page with exactly one page-sized unmeasured polygon', () => {
  for (const [i, page] of overflow.pages.entries()) {
    const fallbacks = pageFallbacks(page);
    expect(fallbacks.length, `page ${i + 1}`).toBe(i === 2 ? 1 : 0);
    if (i === 2) {
      expect(fallbacks[0]?.polygons).toEqual([
        [0, 0, page.width, 0, page.width, page.height, 0, page.height],
      ]);
    } else {
      expect(page.paints.length).toBe(counts[i]);
      expect(page.paints.some(paint => paint.unmeasured)).toBe(false);
    }
  }
});

test('a textless block away from retained paths on an exhausted page reports cannot measure ink instead of trusting incomplete paints', async () => {
  const gt = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'paint-count-budget',
      templateVersion: 1,
      seed: 'T14-9-r14',
      index: 0,
    },
    pages: counts.map(() => ({ width: 100, height: 100 })),
    // Rectangles paint only [0, 0, 50, 50]. The fallback must cover the
    // entire page, even a block that doesn't intersect any retained path.
    blocks: [
      {
        id: 'untrusted',
        type: 'image',
        page: 3,
        order: 0,
        text: '',
        bbox: [70, 70, 90, 90],
      },
    ],
  });
  expect(await checkPdf(overflowPdf, gt)).toEqual({
    ok: false,
    differences: [
      expect.objectContaining({
        kind: 'ink',
        page: 3,
        blockId: 'untrusted',
        message: expect.stringContaining("can't measure"),
      }),
    ],
  });
});

test('a document below the paint cap preserves every measured paint without a spurious page refusal', () => {
  expect(below.pages).toHaveLength(1);
  expect(retained(below)).toBe(1_293);
  const page = below.pages[0];
  if (!page) throw new Error('missing control page');
  expect(pageFallbacks(page)).toEqual([]);
  expect(
    page.paints.every(paint => !paint.unmeasured && paint.color !== undefined),
  ).toBe(true);
});
