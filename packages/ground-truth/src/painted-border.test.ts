// T08-3 slice 2: Chrome paints borders on the same whole-px rect as
// backgrounds: each edge of the border box rounded on its own, measured from
// the printed page's own top-left corner (probed on local Chromium: 1px and
// 0.5px borders, a one-sided border, collapsed and separate tables, on pages
// 1 and 2). A border paints only its own sides' strips: a block whose only
// border is at the bottom has ink on its left, right and bottom edges but not
// at its top, which stays where it was laid out. Offsets are multiples of
// 1/64 px and avoid exact .5 fractions, so every expected box is exact: px
// edge * 0.75, two decimals.
import { fileURLToPath } from 'node:url';
import type { GroundTruth } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-border',
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
  .small { width: 40.5px; height: 30.5px; }
  .wide { width: 100.5px; height: 30.5px; }
  .next { break-before: page; }`;

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

/** Its layout box relative to its page, in px, each edge rounded, as pt. */
async function roundedBox(page: Page, id: string): Promise<number[]> {
  const layout = await page.evaluate(gtId => {
    const element = document.querySelector(`[data-gt-id="${gtId}"]`);
    const sheet = element?.closest('.pagedjs_page');
    if (!element || !sheet) throw new Error(`no ${gtId}`);
    const r = element.getBoundingClientRect();
    const p = sheet.getBoundingClientRect();
    return [r.left - p.left, r.top - p.top, r.right - p.left, r.bottom - p.top];
  }, id);
  // Guard: a layout box already on whole px can't tell rounded from not.
  expect(layout.some(px => px % 1 !== 0)).toBe(true);
  return layout.map(px => Math.round(Math.round(px) * 0.75 * 100) / 100);
}

describe('readGroundTruth: a border is painted on whole px of its page', () => {
  test('a block with a border all round gets each of its four edges rounded on its own, a 0.5px border too', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="framed" class="small" style="border:1px solid #000"></div>
         <div data-gt="paragraph" data-gt-id="hairline" class="small" style="border:0.5px solid #000"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // framed 74.25..114.75 x 100.75..131.25 px, painted 74..115 x 101..131.
      // hairline 74.25..114.75 x 131.25..161.75 px, painted 74..115 x 131..162.
      expect(boxes(result)).toEqual({
        framed: [55.5, 75.75, 86.25, 98.25],
        hairline: [55.5, 98.25, 86.25, 121.5],
      });
    });
  }, 30_000);

  test('a bordered block on page 2 is rounded from page 2s own top-left corner, not the document', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<p data-gt="paragraph" data-gt-id="first">First page</p>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="framed2" class="small" style="border:1px solid #000"></div></div>`,
        css,
      );
      // Page 2 starts 1066.67 px (not a whole px) below page 1's corner:
      // rounding in document coordinates gives y 75.25 / 98.5 here.
      const result = await readGroundTruth(page, source);
      expect(result.pages).toHaveLength(2);
      expect(result.blocks.find(b => b.id === 'framed2')?.page).toBe(2);
      expect(boxes(result).framed2).toEqual([55.5, 75.75, 86.25, 98.25]);
    });
  }, 30_000);

  test('a one-sided border moves the sides its strip reaches and leaves the opposite side where it was laid out', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="ruled" class="wide" style="border-bottom:1.5px solid #000">Total</div>
         <div data-gt="paragraph" data-gt-id="barred" class="wide" style="border-left:2px solid #000">Note</div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // ruled 74.25..174.75 x 100.75..131.25 px: the bottom rule spans its
      // full width, so left, right and bottom become 74, 175 and 131; its top
      // has text, no border, and stays 100.75.
      // barred 74.25..174.75 x 131.25..161.75 px: the left bar spans its full
      // height, so left, top and bottom become 74, 131 and 162; its right
      // stays 174.75.
      expect(boxes(result)).toEqual({
        ruled: [55.5, 75.56, 131.25, 98.25],
        barred: [55.5, 98.25, 131.06, 121.5],
      });
    });
  }, 30_000);

  test('a block takes the painted edges of a bordered element inside it on the sides they share', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="section" style="width:100.5px;height:60.5px">
           Heading<div style="height:10.5px;margin-top:34px;border-bottom:1px solid #000"></div></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Section 74.25..174.75 x 100.75..161.25 px. Its rule (a child whose
      // bottom border ends at 100.75 + 16 + 34 + 10.5 = 161.25 px) is flush
      // with its left, right and bottom: those become 74, 175 and 161; the
      // top (100.75) has text only and stays.
      expect(boxes(result)).toEqual({ section: [55.5, 75.56, 131.25, 120.75] });
    });
  }, 30_000);

  test('an invisible border paints nothing and moves no side', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad">
           <div data-gt="paragraph" data-gt-id="clear" class="small" style="border:2px solid transparent"></div>
           <div data-gt="paragraph" data-gt-id="none" class="small" style="border:2px none #000"></div>
           <div data-gt="paragraph" data-gt-id="hidden" class="small" style="border:2px solid #000;visibility:hidden"></div>
           <div data-gt="paragraph" data-gt-id="zero" class="small" style="border:0 solid #000"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Stacked 30.5 px apart from 74.25..114.75 x 100.75..131.25 px, none
      // painted: every box keeps its layout rect.
      expect(boxes(result)).toEqual({
        clear: [55.69, 75.56, 86.06, 98.44],
        none: [55.69, 98.44, 86.06, 121.31],
        hidden: [55.69, 121.31, 86.06, 144.19],
        zero: [55.69, 144.19, 86.06, 167.06],
      });
    });
  }, 30_000);

  test('a table drawn with collapsed borders is painted on its rounded box, but its cell boxes are not', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><table data-gt="table" data-gt-id="ruled">
           <tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>
         <table data-gt="table" data-gt-id="outlined" style="border:2px solid #000">
           <tr><td style="border:0">A</td><td style="border:0">B</td></tr></table></div>`,
        `${css} table { border-collapse: collapse; table-layout: fixed; width: 100.5px; margin-left: 0.3125px; }
         td { padding: 0; height: 20.3125px; border: 1px solid #000; }`,
      );
      // Collapsed borders stick half out of the cells, so the expected box
      // is each table's own layout box (relative to its page) with each edge
      // rounded: Chrome's table box holds the whole collapsed border.
      const ruled = await roundedBox(page, 'ruled');
      const outlined = await roundedBox(page, 'outlined');
      const result = await readGroundTruth(page, source);
      expect(boxes(result)).toEqual({ ruled, outlined });
      // Cell boxes are table structure, not ink: none of them is rounded.
      const grid = result.blocks[0];
      if (grid?.type !== 'table') throw new Error('not a table');
      const cellLayout = await page.evaluate(() => {
        const table = document.querySelector('[data-gt-id="ruled"]');
        const sheet = table?.closest('.pagedjs_page');
        if (!table || !sheet) throw new Error('no table');
        const p = sheet.getBoundingClientRect();
        return Array.from(table.querySelectorAll('td')).map(cell => {
          const r = cell.getBoundingClientRect();
          return [
            r.left - p.left,
            r.top - p.top,
            r.right - p.left,
            r.bottom - p.top,
          ];
        });
      });
      expect(grid.table.cells.map(cell => cell.bbox)).toEqual(
        cellLayout.map(cell =>
          cell.map(px => Math.round(px * 0.75 * 100) / 100),
        ),
      );
    });
  }, 30_000);

  test('a table with separate borders is painted on its rounded box', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><table data-gt="table" data-gt-id="spaced" style="border:1px solid #000">
           <tr><td>A</td><td>B</td></tr></table></div>`,
        `${css} table { border-collapse: separate; border-spacing: 2.3125px; table-layout: fixed; width: 100.5px; }
         td { padding: 0; height: 20.3125px; border: 1px solid #000; }`,
      );
      const expected = await roundedBox(page, 'spaced');
      const result = await readGroundTruth(page, source);
      expect(boxes(result).spaced).toEqual(expected);
    });
  }, 30_000);
});
