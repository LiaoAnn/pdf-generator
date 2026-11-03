// T08-5 slice 3: an inset box-shadow drawn as a frame paints on whole px like
// a border. Probed on local Chromium 153 (printed PDF, vector and raster):
// an inset shadow paints inside the padding box rounded to whole px (the
// border box when there is no border), never outside it, blur included; it
// paints a strip along each side its offset, spread and blur reach: offset
// toward that side plus spread plus 1.5 × blur (inset 0 -2px 0 0 paints
// only the bottom 2 px, inset 3px 0 0 0 only the left 3 px). Offsets are
// multiples of 1/64 px and avoid exact .5 fractions, so every expected box
// is exact.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-inset-shadow',
  templateVersion: 1,
  seed: 'T08-5',
  index: 0,
};
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

// @page 600pt x 800pt (800 x 1066.67 px, so page 2 starts at a fractional px)
// with 60pt 48pt margins: the content area starts at (64, 80) px of its page.
async function paginate(page: Page, body: string, css = ''): Promise<void> {
  await page.setContent(`<!doctype html><html><head><style>
    @page { size: 600pt 800pt; margin: 60pt 48pt; }
    html, body { margin: 0; padding: 0; }
    * { box-sizing: border-box; }
    p, h1 { margin: 0; }
    body { font: 10pt/12pt sans-serif; }
    ${css}
    </style></head><body>${body}</body></html>`);
  await page.evaluate(`window.__pagedDone = false;
    window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
  await page.addScriptTag({ path: polyfill });
  await page.waitForFunction('window.__pagedDone === true');
}

// Puts its child 10.25 px right of and 20.75 px below the content area's
// corner: a .small child's border box is 74.25..114.75 x 100.75..131.25 px
// of its page, painted on whole px at 74..115 x 101..131.
const css = `.pad { padding: 20.75px 0 0 10.25px; }
  .small { width: 40.5px; height: 30.5px; }
  .next { break-before: page; }`;

/** The .small box as laid out: nothing painted moves it. */
const layoutBox = [55.69, 75.56, 86.06, 98.44];
/** The .small box painted on whole px: 74..115 x 101..131. */
const paintedBox = [55.5, 75.75, 86.25, 98.25];

async function insetShadowed(
  page: Page,
  style: string,
): Promise<Record<string, number[]>> {
  await paginate(
    page,
    `<div class="pad"><div data-gt="paragraph" data-gt-id="card" class="small" style="${style}"></div></div>`,
    css,
  );
  const result = await readGroundTruth(page, source);
  expect(gtSchema.parse(result)).toEqual(result);
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

describe('readGroundTruth: an inset box-shadow paints on whole px like a border', () => {
  test('a frame drawn with an inset spread moves every side, on page 2 as on page 1', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="frame" class="small"
            style="box-shadow: inset 0 0 0 1px #000"></div></div>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="frame2" class="small"
            style="box-shadow: inset 0 0 0 1px #000"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Page 2 starts 1066.67 px down: rounding in document coordinates
      // would land elsewhere.
      expect(result.blocks.map(b => b.page)).toEqual([1, 2]);
      expect(
        Object.fromEntries(result.blocks.map(b => [b.id, b.bbox])),
      ).toEqual({ frame: paintedBox, frame2: paintedBox });
    });
  }, 30_000);

  test('an offset shadow that paints only a bottom rule moves the bottom, left and right sides, not the top', async () => {
    await withPage(async page => {
      // Strip 74.25..114.75 x 129.25..131.25 px.
      expect(
        await insetShadowed(page, 'box-shadow: inset 0 -2px 0 0 #000'),
      ).toEqual({ card: [55.5, 75.56, 86.25, 98.25] });
    });
  }, 30_000);

  test('an offset shadow that paints only a left rule moves the left, top and bottom sides, not the right', async () => {
    await withPage(async page => {
      // Strip 74.25..77.25 x 100.75..131.25 px.
      expect(
        await insetShadowed(page, 'box-shadow: inset 3px 0 0 0 #000'),
      ).toEqual({ card: [55.5, 75.75, 86.06, 98.25] });
    });
  }, 30_000);

  test('a blur reaches 1.5 × its radius into the box: the side the offset leaves gets ink too', async () => {
    await withPage(async page => {
      // Without the blur only the bottom 2 px would paint; with it the
      // shadow's edge reaches 6 - 2 = 4 px down from the top as well.
      expect(
        await insetShadowed(page, 'box-shadow: inset 0 -2px 4px 0 #000'),
      ).toEqual({ card: paintedBox });
    });
  }, 30_000);

  test('with a border the shadow paints inside the padding box: a transparent left border keeps the left side as laid out', async () => {
    await withPage(async page => {
      // Padding box 76.25..114.75 x 100.75..131.25 px, painted 76..115 x
      // 101..131.
      expect(
        await insetShadowed(
          page,
          'border-left: 2px solid transparent; box-shadow: inset 0 0 0 1px #000',
        ),
      ).toEqual({ card: [55.69, 75.75, 86.25, 98.25] });
    });
  }, 30_000);

  test('a half-transparent inset shadow is printed; a fully transparent one is not', async () => {
    await withPage(async page => {
      expect(
        await insetShadowed(
          page,
          'box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.5)',
        ),
      ).toEqual({ card: paintedBox });
      expect(
        await insetShadowed(page, 'box-shadow: inset 0 0 0 1px transparent'),
      ).toEqual({ card: layoutBox });
    });
  }, 30_000);

  test('an inset shadow never grows the box past its border box', async () => {
    await withPage(async page => {
      // A 20 px inset spread fills the whole 74..115 x 101..131 px box and
      // nothing outside it.
      expect(
        await insetShadowed(page, 'box-shadow: inset 0 0 0 20px #000'),
      ).toEqual({ card: paintedBox });
    });
  }, 30_000);
});
