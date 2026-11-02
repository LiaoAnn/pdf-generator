// T08-3 slice 1: Chrome paints a background with each edge of the box rounded
// to whole CSS px on its own, measured from the printed page's own top-left
// corner (probed on local Chromium: 18 of 18 backgrounds, borders and tables
// on pages 1 and 2 of an A4 document). So gt.json boxes of blocks with a
// background, and the sides of a block shared with a background inside it,
// must sit on those painted edges, as images do since T08-2. Offsets are
// multiples of 1/64 px (Chrome's layout unit) and avoid exact .5 fractions,
// so every expected box is exact: px edge * 0.75, two decimals.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildGroundTruth,
  type MeasuredElement,
  readGroundTruth,
} from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-background',
  templateVersion: 1,
  seed: 'T08-3',
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
// corner: the child's border box starts at (74.25, 100.75) on its page.
const css = `.pad { padding: 20.75px 0 0 10.25px; }
  .fill { background: #000; }
  .small { width: 40.5px; height: 30.5px; }
  .next { break-before: page; }`;

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

describe('readGroundTruth: a background is painted on whole px of its page', () => {
  test('a block with a background gets each of its four edges rounded on its own; one without keeps its layout box', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="band" class="fill small"></div>
         <p data-gt="paragraph" data-gt-id="plain" class="small" style="margin-left:10.25px">Text</p></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Band 74.25..114.75 x 100.75..131.25 px: x0 rounds down, x1 up, y0
      // up, y1 down, so rounding only its size or only its origin is off.
      // Painted 74..115 x 101..131 px. The plain paragraph below it (84.5..
      // 125 x 131.25..161.75 px) has nothing painted and keeps its box.
      expect(boxes(result)).toEqual({
        band: [55.5, 75.75, 86.25, 98.25],
        plain: [63.38, 98.44, 93.75, 121.31],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('a block with a background on page 2 is rounded from page 2s own top-left corner, not the document', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<p data-gt="paragraph" data-gt-id="first">First page</p>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="band2" class="fill small"></div></div>`,
        css,
      );
      // Page 2 starts 1066.67 px (not a whole px) below page 1's corner:
      // rounding in document coordinates gives y 75.25 / 98.5 here.
      const result = await readGroundTruth(page, source);
      expect(result.pages).toHaveLength(2);
      expect(result.blocks.find(b => b.id === 'band2')?.page).toBe(2);
      expect(boxes(result).band2).toEqual([55.5, 75.75, 86.25, 98.25]);
    });
  }, 30_000);

  test('a block takes the painted edge on the sides it shares with a background inside it and keeps its own elsewhere', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="card" style="width:100.5px;height:60.5px">
           <div class="fill" style="height:10.5px"></div>Text</div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Card 74.25..174.75 x 100.75..161.25 px; its header band (74.25..
      // 174.75 x 100.75..111.25) is flush with its left, top and right:
      // those become 74, 101 and 175; its bottom (161.25) stays.
      expect(boxes(result)).toEqual({ card: [55.5, 75.75, 131.25, 120.94] });
    });
  }, 30_000);

  test('a table whose header row has a background snaps the sides the row shares, but not the cell boxes', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><table data-gt="table" data-gt-id="grid">
           <thead><tr><th class="fill">A</th></tr></thead>
           <tbody><tr><td>1</td></tr></tbody></table></div>`,
        `${css} table { border-collapse: separate; border-spacing: 0; table-layout: fixed; width: 100.5px; }
         th, td { padding: 0; border: 0; height: 20.5px; }`,
      );
      const result = await readGroundTruth(page, source);
      const grid = result.blocks[0];
      expect(grid?.type).toBe('table');
      if (grid?.type !== 'table') return;
      // Table 74.25..174.75 x 100.75..141.75 px; the header cell's
      // background (74.25..174.75 x 100.75..121.25) shares its left, top and
      // right: those become 74, 101 and 175; the body row paints nothing, so
      // the bottom stays 141.75. Cell boxes are table structure, not ink,
      // and keep their layout rects (as with images in T08-2).
      expect(grid.bbox).toEqual([55.5, 75.75, 131.25, 106.31]);
      expect(grid.table.cells.map(cell => cell.bbox)).toEqual([
        [55.69, 75.56, 131.06, 90.94],
        [55.69, 90.94, 131.06, 106.31],
      ]);
    });
  }, 30_000);

  test('an inline block with a background is painted on its rounded line box', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><span data-gt="paragraph" data-gt-id="tag" class="fill" style="color:#fff;margin-left:0.3125px">Tag</span></div>`,
        css,
      );
      // The span's height and width come from the font, so the expected box
      // is its own layout box (relative to its page) with each edge rounded.
      const expected = await page.evaluate(() => {
        const tag = document.querySelector('[data-gt-id="tag"]');
        const sheet = tag?.closest('.pagedjs_page');
        if (!tag || !sheet) throw new Error('no tag');
        const r = tag.getBoundingClientRect();
        const p = sheet.getBoundingClientRect();
        return [
          r.left - p.left,
          r.top - p.top,
          r.right - p.left,
          r.bottom - p.top,
        ];
      });
      // Guard: the layout box must not already sit on whole px, or the test
      // can't tell rounded from unrounded.
      expect((expected[0] ?? 0) % 1).not.toBe(0);
      const result = await readGroundTruth(page, source);
      expect(boxes(result).tag).toEqual(
        expected.map(px => Math.round(Math.round(px) * 0.75 * 100) / 100),
      );
    });
  }, 30_000);

  test('a transparent or hidden background is not painted and moves no side; a gradient is painted', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad">
           <div data-gt="paragraph" data-gt-id="clear" class="small" style="background:rgba(0,0,0,0)"></div>
           <div data-gt="paragraph" data-gt-id="hidden" class="small" style="margin-left:-0.3125px">
             <div class="fill" style="height:10.5px;visibility:hidden"></div></div>
           <div data-gt="paragraph" data-gt-id="gradient" class="small" style="background:linear-gradient(#000, #888)"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // clear: 74.25..114.75 x 100.75..131.25 px, nothing painted, unrounded.
      // hidden: 73.9375..114.4375 x 131.25..161.75 px; its band is
      // visibility:hidden and paints nothing, so it stays unrounded.
      // gradient: 74.25..114.75 x 161.75..192.25 px, painted 74..115 x
      // 162..192 px.
      expect(boxes(result)).toEqual({
        clear: [55.69, 75.56, 86.06, 98.44],
        hidden: [55.45, 98.44, 85.83, 121.31],
        gradient: [55.5, 121.5, 86.25, 144],
      });
    });
  }, 30_000);
});

describe('buildGroundTruth: painted boxes of a hand-made measurement', () => {
  function block(patch: Partial<MeasuredElement>): MeasuredElement {
    return {
      type: 'paragraph',
      id: 'band',
      ref: null,
      splitFrom: null,
      page: 0,
      region: 'area',
      rect: { x: 74.25, y: 100.75, width: 40.5, height: 30.5 },
      text: '',
      nested: false,
      ...patch,
    };
  }

  test('a box is painted with each edge rounded, like an img and unlike an svg', () => {
    // 74.25..114.75 x 100.75..131.25 px. An img and a box paint 74..115 x
    // 101..131; an svg paints from its rounded origin at its own size,
    // 74..114.5 x 101..131.5 clipped to 131, which would give x1 85.88.
    const rect = { x: 74.25, y: 100.75, width: 40.5, height: 30.5 };
    const result = boxes(
      buildGroundTruth(
        {
          pages: [{ x: 0, y: 0, width: 800, height: 1066.671875 }],
          elements: [block({ rect, painted: [{ kind: 'box', rect }] })],
        },
        source,
      ),
    );
    expect(result).toEqual({ band: [55.5, 75.75, 86.25, 98.25] });
  });
});
