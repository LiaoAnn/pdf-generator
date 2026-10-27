import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { checkPdf, readPdf } from './index.ts';

let pdf: Uint8Array;
let reference: GroundTruth;
let budgetPdf: Uint8Array;

beforeAll(async () => {
  const html = await readFile(
    new URL('../fixtures/textless-geometry.html', import.meta.url),
    'utf8',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.evaluate(`(async () => {
      const image = document.querySelector('#gradient-image');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      canvas.getContext('2d').fillRect(0, 0, 8, 8);
      image.src = canvas.toDataURL('image/png');
      await image.decode();
      canvas.getContext('2d').clearRect(0, 0, 8, 8);
      const transparent = document.querySelector('#transparent-image');
      transparent.src = canvas.toDataURL('image/png');
      await transparent.decode();
    })()`);
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(`window.__pagedDone = false; window.PagedConfig = {
      auto: true, after: () => { window.__pagedDone = true; }
    };`);
    await page.addScriptTag({
      path: fileURLToPath(
        new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
      ),
    });
    await page.waitForFunction('window.__pagedDone === true');
    await page.evaluate('document.fonts.ready');
    expect(await page.locator('.pagedjs_page').count()).toBe(1);
    // Independent oracle: Paged.js DOM boxes, never PDF drawing bounds.
    const blocks = await page.evaluate(`(() =>
      [...document.querySelectorAll('.pagedjs_pages [data-gt]')].map((el, order) => {
        const r = el.getBoundingClientRect();
        const paper = el.closest('.pagedjs_page').getBoundingClientRect();
        return { id: el.id, type: el.dataset.gt, page: 1, order, text: '',
          bbox: [r.left - paper.left, r.top - paper.top, r.right - paper.left, r.bottom - paper.top].map(v => v * .75) };
      }))()`);
    reference = gtSchema.parse({
      schemaVersion: 1,
      source: {
        templateId: 'textless-geometry',
        templateVersion: 1,
        seed: 'T14-9',
        index: 0,
      },
      pages: [{ width: 595.28, height: 841.89 }],
      blocks,
    });
    expect(reference.blocks).toHaveLength(18);
    pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    expect((await readPdf(pdf)).pages.flatMap(page => page.items)).toEqual([]);
    // One large solid PNG compresses small; retain only PDFs, not pixel buffers.
    await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2100;
      canvas.getContext('2d').fillRect(0, 0, 2100, 2100);
      const image = document.querySelector('.pagedjs_pages #gradient-image');
      image.src = canvas.toDataURL('image/png');
      await image.decode();
    })()`);
    budgetPdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
});

function gt(id: string) {
  const value = structuredClone(reference);
  value.blocks = value.blocks.filter(block => block.id === id);
  expect(value.blocks).toHaveLength(1);
  const block = value.blocks[0];
  if (!block) throw new Error(`missing block: ${id}`);
  block.order = 0;
  return gtSchema.parse(value);
}

test('a black-rect SVG pattern is visible measurable ink', async () => {
  expect(await checkPdf(pdf, gt('black-pattern'))).toEqual({
    ok: true,
    differences: [],
  });
});

test('CSS repeating-gradient barcode bars are visible measurable ink', async () => {
  expect(await checkPdf(pdf, gt('repeating-bars'))).toEqual({
    ok: true,
    differences: [],
  });
});

test.each([
  ['mask-pattern', 'a black pattern in a luminosity mask'],
  ['mask-group', 'white then black in a half-opacity mask group'],
])('%s refuses %s hidden by a soft-mask transfer', async (id, _regression) => {
  const report = await checkPdf(pdf, gt(id));
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({ kind: 'ink', blockId: id }),
  ]);
});

test('readPdf marks a 2100-by-2100 PNG exceeding the per-page pixel budget unmeasured', async () => {
  const expected = gt('gradient-image');
  const box = expected.blocks[0]?.bbox;
  if (!box) throw new Error('missing block');
  const document = await readPdf(budgetPdf);
  const imagePaint = document.pages[0]?.paints.find(
    p =>
      Math.abs(p.box[0] - box[0]) < 1 &&
      Math.abs(p.box[1] - box[1]) < 1 &&
      Math.abs(p.box[2] - box[2]) < 1 &&
      Math.abs(p.box[3] - box[3]) < 1,
  );
  expect(
    imagePaint,
    'large PNG must remain represented, fail closed',
  ).toBeDefined();
  expect(imagePaint?.unmeasured).toBe(true);
  expect(imagePaint?.image).toBeUndefined();
});

test('checkPdf refuses a block drawn only by an over-budget PNG with a cannot-measure diagnostic', async () => {
  const expected = gt('gradient-image');
  const report = await checkPdf(budgetPdf, expected);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'ink',
      blockId: 'gradient-image',
      message: expect.stringContaining("can't measure"),
    }),
  ]);
});

test.each([
  ['cancelled-path', 'a self-cancelling even-odd path'],
  ['white-path', 'a white full-box rectangle'],
  ['erased-path', 'a black rectangle erased by white'],
  ['empty-clip', 'a full-box rectangle under an empty even-odd clip'],
  ['band-hidden', 'content identical in colour to its enclosing band'],
  [
    'group-erased',
    'black then white composited together in a half-opacity group',
  ],
  ['white-gradient', 'a white-to-white gradient'],
  ['white-pattern', 'an SVG white-rect pattern'],
  ['transparent-image', 'an all-transparent PNG image'],
])('%s rejects %s as painting nothing', async (id, _regression) => {
  const expected = gt(id);
  const report = await checkPdf(pdf, expected);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    {
      kind: 'ink',
      page: 1,
      blockId: id,
      bbox: expected.blocks[0]?.bbox,
      message: expect.stringContaining('paints nothing'),
    },
  ]);
});

test('two corner squares in one path cannot borrow its full-box bounds for coverage', async () => {
  const report = await checkPdf(pdf, gt('corner-path'));
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'ink',
      blockId: 'corner-path',
      message: expect.stringContaining('less than half'),
    }),
  ]);
});

test('a cancelled full-box path cannot anchor off-centre real ink', async () => {
  const expected = gt('unanchored-path');
  const report = await checkPdf(pdf, expected);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'ink',
      blockId: 'unanchored-path',
      message: expect.stringContaining("doesn't fit"),
    }),
  ]);
  const difference = report.differences[0];
  if (difference?.kind !== 'ink' || !difference.inkBox)
    throw new Error('expected visible ink bounds');
  // SVG's 10,20–70,30 px rectangle, converted independently to PDF points.
  const box = expected.blocks[0]?.bbox;
  if (!box) throw new Error('missing block bounds');
  [box[0] + 7.5, box[1] + 15, box[0] + 52.5, box[1] + 22.5].forEach(
    (edge, i) => {
      expect(
        Math.abs((difference.inkBox?.[i] ?? NaN) - edge),
      ).toBeLessThanOrEqual(1);
    },
  );
});

test('a contrasting logo on a coloured enclosing band remains verifiable', async () => {
  expect(await checkPdf(pdf, gt('band-logo'))).toEqual({
    ok: true,
    differences: [],
  });
});

test('a visible red-to-blue gradient remains verifiable as ink', async () => {
  expect(await checkPdf(pdf, gt('visible-gradient'))).toEqual({
    ok: true,
    differences: [],
  });
});

test('an opaque raster image over a gradient band cannot cancel as the same unknown colour', async () => {
  expect(await checkPdf(pdf, gt('gradient-image'))).toEqual({
    ok: true,
    differences: [],
  });
});
