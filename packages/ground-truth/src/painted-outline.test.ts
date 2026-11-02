// T08-4 slice 1: an outline paints outside the border box, so the gt box of
// a block grows to cover it (the outline of the block itself or of anything
// inside it). Chrome paints it around the border box rounded to whole CSS px
// of the printed page, at the computed outline-offset plus outline-width
// (both already snapped by Chrome: 2.5px → 2px, 3.3px → 3px), on page 2 as on
// page 1 (probed on local Chromium, 24 cases on pages 1 and 2). It shows only
// inside the overflow clips around it and its page: a clipped part adds
// nothing. An outline inside the box never moves a side inwards.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-outline',
  templateVersion: 1,
  seed: 'T08-4',
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
// of its page, rounded 74..115 x 101..131.
const css = `.pad { padding: 20.75px 0 0 10.25px; }
  .small { width: 40.5px; height: 30.5px; }
  .next { break-before: page; }`;

/** The .small box with nothing painted: its layout edges in pt. */
const layoutBox = [55.69, 75.56, 86.06, 98.44];

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

const pt = (px: number) => Math.round(px * 0.75 * 100) / 100;

describe('readGroundTruth: an outline is in its block’s box', () => {
  test('a block’s own outline grows its box to the rounded border box plus offset and width, on page 2 as on page 1', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="framed" class="small"
            style="outline: 2.5px solid #000; outline-offset: 3.3px"></div></div>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="framed2" class="small"
            style="outline: 2.5px solid #000; outline-offset: 3.3px"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Chrome computes width 2px, offset 3px: 74..115 x 101..131 grown by
      // 5 is 69..120 x 96..136 px on each page (page 2 starts at 1066.67 px).
      expect(result.pages).toHaveLength(2);
      expect(result.blocks.map(b => b.page)).toEqual([1, 2]);
      expect(boxes(result)).toEqual({
        framed: [51.75, 72, 90, 102],
        framed2: [51.75, 72, 90, 102],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('an outline drawn inside the box (negative offset) moves no side', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="inset" class="small"
            style="outline: 2px solid #000; outline-offset: -5px"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      expect(boxes(result)).toEqual({ inset: layoutBox });
    });
  }, 30_000);

  test.each([
    ['style none', 'outline: 3px none #000'],
    ['transparent colour', 'outline: 3px solid transparent'],
    ['zero alpha in slash syntax', 'outline: 3px solid rgb(0 0 0 / 0)'],
    ['visibility hidden', 'outline: 3px solid #000; visibility: hidden'],
  ])(
    'an outline that paints nothing (%s) moves no side',
    async (_, style) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="none" class="small"
            style="${style}"></div></div>`,
          css,
        );
        const result = await readGroundTruth(page, source);
        expect(boxes(result)).toEqual({ none: layoutBox });
      });
    },
    30_000,
  );

  test('the outline of an element inside the block counts too', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="holder" class="small">
           <div style="height: 100%; outline: 2px solid #000"></div></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // The child fills the block: 74..115 x 101..131 grown by 2.
      expect(boxes(result)).toEqual({ holder: [54, 74.25, 87.75, 99.75] });
    });
  }, 30_000);

  test('an <svg> block’s own outline counts as an element’s does', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><svg data-gt="image" data-gt-id="drawing" class="small"
            style="display: block; outline: 2px solid #000" viewBox="0 0 40 30">
            <rect width="40" height="30" fill="#00f"/></svg></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Its border box 74..115 x 101..131 rounded, outlined 2 px.
      expect(boxes(result)).toEqual({ drawing: [54, 74.25, 87.75, 99.75] });
    });
  }, 30_000);

  test('an inline element broken over lines is outlined on each line box: the block covers every one', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><p data-gt="paragraph" data-gt-id="wrapped" style="width: 60.5px">
           <span id="mark" style="outline: 3px solid #000">aaa bbb ccc ddd</span></p></div>`,
        css,
      );
      // The line boxes depend on the font, so they are read from the page.
      const measured = (await page.evaluate(`(() => {
        const span = document.querySelector('#mark');
        const p = span.closest('p');
        const origin = span.closest('.pagedjs_page').getBoundingClientRect();
        const edges = r => [r.left - origin.x, r.top - origin.y, r.right - origin.x, r.bottom - origin.y];
        return { block: edges(p.getBoundingClientRect()), lines: Array.from(span.getClientRects(), edges) };
      })()`)) as { block: number[]; lines: number[][] };
      expect(measured.lines.length).toBeGreaterThanOrEqual(2);
      const outlines = measured.lines.map(
        ([x0 = 0, y0 = 0, x1 = 0, y1 = 0]) => [
          Math.round(x0) - 3,
          Math.round(y0) - 3,
          Math.round(x1) + 3,
          Math.round(y1) + 3,
        ],
      );
      const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = measured.block;
      const expected = [
        Math.min(b0, ...outlines.map(o => o[0] ?? 0)),
        Math.min(b1, ...outlines.map(o => o[1] ?? 0)),
        Math.max(b2, ...outlines.map(o => o[2] ?? 0)),
        Math.max(b3, ...outlines.map(o => o[3] ?? 0)),
      ].map(pt);
      // The outlines stick out of the paragraph: the test means something.
      expect(expected).not.toEqual(measured.block.map(pt));
      const result = await readGroundTruth(page, source);
      expect(boxes(result).wrapped).toEqual(expected);
    });
  }, 30_000);

  test('an outline entirely hidden by an overflow clip at the block’s own edges moves no side', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div class="small" style="overflow: hidden">
           <div data-gt="paragraph" data-gt-id="hidden" style="height: 100%; outline: 2.5px solid #000"></div>
         </div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // The outline (72..117 x 99..133 px, 2 px wide) lies wholly outside
      // the clip (74..115 x 101..131 px): nothing of it is printed.
      expect(boxes(result)).toEqual({ hidden: layoutBox });
    });
  }, 30_000);

  test('an outline partly hidden by an overflow clip grows the box only as far as the clip', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div style="overflow: hidden; padding: 1.3125px; width: 43.125px; height: 33.125px">
           <div data-gt="paragraph" data-gt-id="cut" style="height: 100%; outline: 2.5px solid #000"></div>
         </div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Block 75.5625..116.0625 x 102.0625..132.5625 px, rounded 76..116 x
      // 102..133; its outline 74..118 x 100..135 is cut by the clip
      // (74.25..117.375 x 100.75..133.875, rounded 74..117 x 101..134).
      expect(boxes(result)).toEqual({ cut: [55.5, 75.75, 87.75, 100.5] });
    });
  }, 30_000);

  test('an outline reaching past the page is cut at its own page’s edges, on page 2 as on page 1', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="wide" class="small"
            style="outline: 2px solid #000; outline-offset: 120px"></div></div>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="wide2" class="small"
            style="outline: 2px solid #000; outline-offset: 120px"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // -48..237 x -21..253 px, cut at the page's top and left: the top and
      // left strips vanish; the right and bottom ones reach 0.
      expect(boxes(result)).toEqual({
        wide: [0, 0, 177.75, 189.75],
        wide2: [0, 0, 177.75, 189.75],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);
});
