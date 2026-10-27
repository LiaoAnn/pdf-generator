// T08-2 slice 1: Chrome paints an <img> on whole CSS px of the printed page
// (each edge of its border box rounded on its own, relative to the page's own
// top-left corner), so gt.json boxes of images, and of blocks flush with one,
// must sit on those painted edges. Offsets below are multiples of 1/64 px
// (Chrome's layout unit) and avoid exact .5 fractions, so every expected box
// is exact. Expected boxes are hand-derived: px edge * 0.75, two decimals.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildGroundTruth,
  type MeasuredElement,
  type Measurement,
  readGroundTruth,
} from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'replaced-img',
  templateVersion: 1,
  seed: 'T08-2',
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

const gray =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect width='4' height='4' fill='gray'/%3E%3C/svg%3E";

// Puts its child 10.25 px right of and 20.75 px below the content area's
// corner: the child's border box starts at (74.25, 100.75) on its page.
const css = `.pad { padding: 20.75px 0 0 10.25px; }
  .pad > img, .pad > div > img, td > img { display: block; }
  .pad > img { width: 40.5px; height: 30.5px; }
  .next { break-before: page; }`;

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

describe('readGroundTruth: an <img> is painted on whole px of its page', () => {
  test('an img[data-gt] gets each of its four edges rounded on its own', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><img data-gt="image" data-gt-id="logo" alt="" src="${gray}"></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Layout box 74.25..114.75 x 100.75..131.25 px: x0 rounds down, x1 up,
      // y0 up, y1 down, so a rounding of size or of the origin alone is off.
      // Painted 74..115 x 101..131 px.
      expect(boxes(result)).toEqual({ logo: [55.5, 75.75, 86.25, 98.25] });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('an img on page 2 is rounded from page 2s own top-left corner, not the document', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<p data-gt="paragraph" data-gt-id="first">First page</p>
         <div class="pad next"><img data-gt="image" data-gt-id="logo2" alt="" src="${gray}"></div>`,
        css,
      );
      // Page 2 starts 1066.67 px (not a whole px) below page 1's corner: a
      // rounding in document coordinates paints the image a fraction of a px
      // off the whole-px rect and gives y 75.25 / 98.5 here.
      const result = await readGroundTruth(page, source);
      expect(result.pages).toHaveLength(2);
      expect(boxes(result).logo2).toEqual([55.5, 75.75, 86.25, 98.25]);
      expect(result.blocks.find(b => b.id === 'logo2')?.page).toBe(2);
    });
  }, 30_000);

  test('a block holding an img takes the painted edge on the sides they share and keeps its own elsewhere', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="figure" style="width:100.5px;height:60.5px">
           <img alt="" src="${gray}" style="width:40.5px;height:30.5px"></div></div>
         <p data-gt="paragraph" data-gt-id="plain" style="margin-left:10.25px;width:40.5px;height:10.5px">Text</p>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Figure 74.25..174.75 x 100.75..161.25 px; the image is flush with its
      // left and top only: those become 74 and 101, its right (174.75) and
      // bottom (161.25) stay unrounded. The plain paragraph has no image: its
      // 74.25..114.75 x 161.25..171.75 px box stays unrounded as before.
      expect(boxes(result)).toEqual({
        figure: [55.5, 75.75, 131.06, 120.94],
        plain: [55.69, 120.94, 86.06, 128.81],
      });
    });
  }, 30_000);

  test('a block grows to contain the painted img when rounding pushes it past the block', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="figure" style="width:40.625px;height:30.125px">
           <img alt="" src="${gray}" style="width:40.5px;height:30px"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Figure 74.25..114.875 x 100.75..130.875 px; the image ends at 114.75
      // and 130.75, inside it, but paints to 115 and 131: past the figure's
      // own right and bottom. The box must cover the ink: 74..115 x 101..131.
      expect(boxes(result)).toEqual({ figure: [55.5, 75.75, 86.25, 98.25] });
    });
  }, 30_000);

  test('an img clipped out of its block by overflow:hidden is not counted', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="figure" style="width:40.625px;height:30.125px;overflow:hidden">
           <img alt="" src="${gray}" style="width:100.5px;height:30px"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // The image starts flush with the figure's left and top but is 60 px
      // wider than it (what KaTeX's wide svgs do). Counting it would snap the
      // figure to 74 / 101 px (55.5 / 75.75 pt); it must keep 74.25..114.875
      // x 100.75..130.875 px.
      expect(boxes(result)).toEqual({ figure: [55.69, 75.56, 86.16, 98.16] });
    });
  }, 30_000);

  test('a table whose img cell is flush with it snaps the table block but not the cell boxes', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><table data-gt="table" data-gt-id="grid">
           <tbody><tr><td><img alt="" src="${gray}" style="width:40.5px;height:30.5px"></td></tr></tbody></table></div>`,
        `${css} table { border-collapse: separate; border-spacing: 0; }
         td { padding: 0; border: 0; }`,
      );
      const result = await readGroundTruth(page, source);
      const grid = result.blocks[0];
      expect(grid?.type).toBe('table');
      if (grid?.type !== 'table') return;
      // The table and its only cell are both 74.25..114.75 x 100.75..131.25
      // px with the image flush on all sides: the block snaps to 74..115 x
      // 101..131 px, but cell boxes are table structure, not ink, and keep
      // the layout rect.
      expect(grid.bbox).toEqual([55.5, 75.75, 86.25, 98.25]);
      expect(grid.table.cells.map(cell => cell.bbox)).toEqual([
        [55.69, 75.56, 86.06, 98.44],
      ]);
    });
  }, 30_000);
});

describe('buildGroundTruth: replaced <img> elements of a hand-made measurement', () => {
  function figure(patch: Partial<MeasuredElement>): MeasuredElement {
    return {
      type: 'image',
      id: 'figure',
      ref: null,
      splitFrom: null,
      page: 0,
      region: 'area',
      rect: { x: 10, y: 100.5, width: 90, height: 100 },
      text: '',
      nested: false,
      ...patch,
    };
  }

  function build(
    elements: MeasuredElement[],
    pages: Measurement['pages'] = [{ x: 0, y: 0, width: 800, height: 1120 }],
  ): Record<string, number[]> {
    return boxes(buildGroundTruth({ pages, elements }, source));
  }

  test('imgs within 0.01 px of a side are flush with it, and the box takes the outermost of their painted edges', () => {
    // Both imgs are within 0.005 px of the block's top (100.5) and bottom
    // (200.5) but round to different px: A paints top 100 / bottom 200, B
    // paints top 101 / bottom 201. The box is 100..201 px: neither img alone
    // gives both, and an exact-equality flush test sees neither as flush and
    // leaves the layout rect.
    const a = { x: 20, y: 100.495, width: 10, height: 100 };
    const b = { x: 40, y: 100.505, width: 10, height: 100 };
    expect(
      build([
        figure({
          replaced: [
            { kind: 'img', rect: a },
            { kind: 'img', rect: b },
          ],
        }),
      ]),
    ).toEqual({ figure: [7.5, 75, 75, 150.75] });
  });

  test('flush sides snap on a page that starts on a fractional px, measured from that page', () => {
    // Page 2's corner is at y 1200.671875 (as in a 1122.52 px A4 stack). The
    // block and its img are at 74.25..114.75 x 100.75..131.25 px of the page,
    // flush all round: painted 74..115 x 101..131 px.
    const rect = { x: 74.25, y: 1301.421875, width: 40.5, height: 30.5 };
    expect(
      build(
        [figure({ page: 1, rect, replaced: [{ kind: 'img', rect }] })],
        [
          { x: 0, y: 0, width: 800, height: 1066.671875 },
          { x: 0, y: 1200.671875, width: 800, height: 1066.671875 },
        ],
      ),
    ).toEqual({ figure: [55.5, 75.75, 86.25, 98.25] });
  });

  test('an img counts when it sticks out of the block by 0.005 px but not by 0.02 px', () => {
    // Block x 74.25..174.75. An img starting 0.005 px left of it is still
    // inside (and flush) and paints from 74; one starting 0.02 px left of it
    // is outside, so it neither moves the edge nor grows the box to 74.
    const within = figure({
      id: 'within',
      rect: { x: 74.25, y: 100.75, width: 100.5, height: 60.5 },
      replaced: [
        { kind: 'img', rect: { x: 74.245, y: 100.75, width: 40, height: 30 } },
      ],
    });
    const outside = figure({
      id: 'outside',
      rect: { x: 74.25, y: 100.75, width: 100.5, height: 60.5 },
      replaced: [
        { kind: 'img', rect: { x: 74.23, y: 100.75, width: 40, height: 30 } },
      ],
    });
    const result = build([within, outside]);
    expect(result.within?.[0]).toBe(55.5);
    expect(result.outside?.[0]).toBe(55.69);
  });

  test('an element with an empty or missing replaced list keeps its layout rect', () => {
    const rect = { x: 74.25, y: 100.75, width: 40.5, height: 30.5 };
    expect(
      build([
        figure({ id: 'none', rect }),
        figure({ id: 'empty', rect, replaced: [] }),
      ]),
    ).toEqual({
      none: [55.69, 75.56, 86.06, 98.44],
      empty: [55.69, 75.56, 86.06, 98.44],
    });
  });
});
