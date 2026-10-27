import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, describe, expect, test } from 'vitest';
import { checkPdf, readPdf } from './index.ts';
import { maxInkWork } from './ink.ts';

test('overlapping SVG use rectangles exceeding maxInkWork are refused with cannot-measure instead of passing textless ink checks', async () => {
  // A 160 px square is 120 pt square: 230,400 quarter-point samples.
  // A 50% margin over the two-render budget keeps PDF rounding irrelevant.
  const count = Math.ceil((1.5 * maxInkWork) / (2 * ((120 * 120) / 0.0625)));
  const html = `<style>@page{size:240px 240px;margin:0}body{margin:0}</style>
    <svg data-gt="image" width="160" height="160"><defs>
    <rect id="r" width="160" height="160" fill="black"/></defs>
    ${'<use href="#r"/>'.repeat(count)}</svg>`;
  expect(Buffer.byteLength(html)).toBeLessThan(10_000);
  const browser = await chromium.launch({ headless: true });
  let printed: Uint8Array;
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    printed = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
  const document = await readPdf(printed);
  expect(document.pages).toHaveLength(1);
  expect(document.pages[0]?.items).toEqual([]);
  expect(document.pages[0]?.paints).toHaveLength(count);
  const expected = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'overlapping-use',
      templateVersion: 1,
      seed: 'T14-9-r12',
      index: 0,
    },
    pages: [{ width: 180, height: 180 }],
    blocks: [
      {
        id: 'overlapping-use',
        type: 'image',
        page: 1,
        order: 0,
        text: '',
        bbox: [0, 0, 120, 120],
      },
    ],
  });
  const report = await checkPdf(printed, expected);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'ink',
      blockId: 'overlapping-use',
      message: expect.stringContaining("can't measure"),
    }),
  ]);
});

test.each([
  { alpha: 0.5, overpaint: true },
  { alpha: 0.25, overpaint: true },
  { alpha: 0.5, overpaint: false },
])(
  'masked group at $alpha with white overpaint=$overpaint is judged after compositing, without a border frame',
  async ({ alpha, overpaint }) => {
    const html = (
      await readFile(
        new URL('../fixtures/masked-group.html', import.meta.url),
        'utf8',
      )
    )
      .replace('MASK_ALPHA', String(alpha))
      .replace(
        '<!-- OVERPAINT -->',
        overpaint ? '<rect width="100" height="100" fill="white" />' : '',
      );
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
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
      const bbox = await page.evaluate(`(() => {
      const el = document.querySelector('.pagedjs_pages [data-gt]');
      const r = el.getBoundingClientRect();
      const paper = el.closest('.pagedjs_page').getBoundingClientRect();
      return [r.left - paper.left, r.top - paper.top, r.right - paper.left, r.bottom - paper.top].map(v => v * .75);
    })()`);
      expect(bbox).toEqual([30, 30, 105, 105]);
      const expected = gtSchema.parse({
        schemaVersion: 1,
        source: {
          templateId: 'masked-group',
          templateVersion: 1,
          seed: 'T14-9-r9',
          index: 0,
        },
        pages: [{ width: 240, height: 300 }],
        blocks: [
          {
            id: 'masked-group',
            type: 'image',
            page: 1,
            order: 0,
            text: '',
            bbox,
          },
        ],
      });
      const printed = await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
      });
      const directory = await mkdtemp(join(tmpdir(), 'masked-group-r9-'));
      const input = join(directory, 'group.pdf');
      await writeFile(input, printed);
      const rendered = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../../dev-tools/src/cli.ts', import.meta.url)),
        input,
      ]);
      expect(rendered.stdout.trim()).toBe(join(directory, 'group-p1.png'));
      const png = await readFile(join(directory, 'group-p1.png'));
      // Decode the actual pdf-to-png output, not a screenshot of the source SVG.
      // Scan the whole page too: a one-pixel fringe outside the box must fail.
      const pixels = await page.evaluate(`(async () => {
      const image = new Image();
      image.src = 'data:image/png;base64,${Buffer.from(png).toString('base64')}';
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonwhite = 0, inside = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) {
          nonwhite++;
          const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width);
          if (x >= 60 && x < 210 && y >= 60 && y < 210) inside++;
        }
      }
      return { width: canvas.width, height: canvas.height, nonwhite, inside };
    })()`);
      expect(pixels).toEqual({
        width: 480,
        height: 600,
        nonwhite: overpaint ? 0 : 22500,
        inside: overpaint ? 0 : 22500,
      });
      const report = await checkPdf(printed, expected);
      if (overpaint) {
        expect(report.ok).toBe(false);
        expect(report.differences).toEqual([
          expect.objectContaining({ kind: 'ink', blockId: 'masked-group' }),
        ]);
      } else {
        expect(report).toEqual({ ok: true, differences: [] });
      }
    } finally {
      await browser.close();
    }
  },
);

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

// Small real Chromium PDFs: only one black rectangle, no fonts or raster images.
describe.each([3, 40])('%i nested SVG transparency groups', depth => {
  let printed: Uint8Array;
  const expected = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'nested-groups',
      templateVersion: 1,
      seed: 'T14-9-r11',
      index: 0,
    },
    pages: [{ width: 90, height: 90 }],
    blocks: [
      {
        id: 'nested-rect',
        type: 'image',
        page: 1,
        order: 0,
        text: '',
        // SVG rectangle at (20,20), 80 by 80 CSS pixels; 0.75 pt per px.
        bbox: [15, 15, 75, 75],
      },
    ],
  });

  beforeAll(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <style>@page { size: 120px 120px; margin: 0 } body { margin: 0 }</style>
        <svg width="120" height="120" viewBox="0 0 120 120">
          ${'<g opacity="0.99">'.repeat(depth)}
          <rect x="20" y="20" width="80" height="80" fill="black"/>
          ${'</g>'.repeat(depth)}
        </svg>`);
      printed = await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
      });
      expect(printed.byteLength).toBeLessThan(20_000);
    } finally {
      await browser.close();
    }
  });

  test('readPdf retains the rectangle and rejects excessive group depth instead of trusting its black colour', async () => {
    const document = await readPdf(printed);
    expect(document.pages).toHaveLength(1);
    const paints = document.pages[0]?.paints;
    expect(paints).toHaveLength(1);
    const rect = paints?.[0];
    expect(rect?.box).toEqual([
      expect.closeTo(15, 4),
      expect.closeTo(15, 4),
      expect.closeTo(75, 4),
      expect.closeTo(75, 4),
    ]);
    if (depth > 32) {
      expect(rect?.unmeasured).toBe(true);
    } else {
      expect(rect?.unmeasured).not.toBe(true);
      expect(rect?.groups).toHaveLength(depth);
      expect(rect?.color).toBe('#000000');
    }
  });

  test('checkPdf reports cannot-measure for excessive depth while accepting shallow transparent ink', async () => {
    const report = await checkPdf(printed, expected);
    if (depth > 32) {
      expect(report.ok).toBe(false);
      expect(report.differences).toEqual([
        expect.objectContaining({
          kind: 'ink',
          blockId: 'nested-rect',
          message: expect.stringContaining("can't measure"),
        }),
      ]);
    } else {
      expect(report).toEqual({ ok: true, differences: [] });
    }
  });
});
