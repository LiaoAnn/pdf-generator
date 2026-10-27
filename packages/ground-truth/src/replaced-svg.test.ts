// T08-2 slice 2: Chrome paints an <svg> that is not inside another <svg> with
// its origin rounded to whole CSS px of the printed page and its drawing at
// its unrounded size, clipped to its rounded box:
//   x0' = round(x0), x1' = min(x0' + width, round(x1)), likewise y.
// So the ink of a barcode can end short of, or on, its layout edge, and
// gt.json boxes bounded by an svg must sit on that painted rect. Offsets are
// multiples of 1/64 px (Chrome's layout unit) and avoid exact .5 fractions, so
// every expected box is exact. Expected boxes are hand-derived: px edge *
// 0.75, two decimals.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { collect } from './collect.js';
import {
  buildGroundTruth,
  type MeasuredElement,
  type Measurement,
  readGroundTruth,
} from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'replaced-svg',
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

const bars = `<rect width="100%" height="100%" fill="black"/>`;

// `.up`/`.down` say how the child's origin rounds: `.up` puts it at
// (74.75, 100.25) px of its page (x rounds up, y down), `.down` at
// (74.25, 100.75) (x down, y up).
const css = `.up { padding: 20.25px 0 0 10.75px; }
  .down { padding: 20.75px 0 0 10.25px; }
  svg { display: block; }
  .next { break-before: page; }`;

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

describe('readGroundTruth: an <svg> is painted from a rounded origin at its own size', () => {
  test('an svg[data-gt] starts on its rounded origin, keeps its size, and is clipped to its rounded box', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="up"><svg data-gt="image" data-gt-id="mark" width="40.375" height="30.625">${bars}</svg></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Layout box 74.75..115.125 x 100.25..130.875 px. x: origin up to 75,
      // 75 + 40.375 = 115.375 is clipped to round(115.125) = 115. y: origin
      // down to 100, 100 + 30.625 = 130.625 is short of round(130.875) = 131,
      // so the ink ends at 130.625. Painted 75..115 x 100..130.625 px.
      expect(boxes(result)).toEqual({ mark: [56.25, 75, 86.25, 97.97] });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('an svg on page 2 is rounded from page 2s own top-left corner, not the document', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<p data-gt="paragraph" data-gt-id="first">First page</p>
         <div class="down next"><svg data-gt="image" data-gt-id="mark2" width="40.375" height="30.375">${bars}</svg></div>`,
        css,
      );
      // Layout box 74.25..114.625 x 100.75..131.125 px of page 2. x: origin
      // down to 74, 74 + 40.375 = 114.375 is short of round(114.625) = 115.
      // y: origin up to 101, 101 + 30.375 = 131.375 is clipped to
      // round(131.125) = 131. Page 2 starts 1066.67 px (not a whole px) below
      // page 1's corner, so a rounding in document coordinates misses it.
      const result = await readGroundTruth(page, source);
      expect(result.pages).toHaveLength(2);
      expect(boxes(result).mark2).toEqual([55.5, 75.75, 85.78, 98.25]);
      expect(result.blocks.find(b => b.id === 'mark2')?.page).toBe(2);
    });
  }, 30_000);

  test('a barcode block whose top and bottom are its svgs takes their painted edges and keeps its padded sides', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="up"><div data-gt="barcode" data-gt-id="code" style="width:120.5px;padding:0 10.25px">
           <svg width="100" height="10.375">${bars}</svg><svg width="100" height="20.25">${bars}</svg></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Block 74.75..195.25 x 100.25..130.875 px; the svgs are 100 px wide at
      // x 85, so left and right are padding and stay unrounded (56.06, 146.44).
      // Top svg starts flush at 100.25 and paints from 100. The bottom svg
      // spans 110.625..130.875 and paints 111..min(111 + 20.25, 131) = 131:
      // the bottom edge is the second svg's, not the first's (110.375).
      expect(boxes(result)).toEqual({ code: [56.06, 75, 146.44, 98.25] });
    });
  }, 30_000);

  test('an svg wider than its overflow:hidden block is not counted', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="up"><div data-gt="barcode" data-gt-id="code" style="width:40.625px;height:30.625px;overflow:hidden">
           <svg width="100.5" height="30.625">${bars}</svg></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // The svg is flush with the block's left and top but 60 px wider than
      // it (what KaTeX's wide svgs do). Counting it would snap the block's
      // left to 75 px (56.25 pt); it must keep 74.75..115.375 x 100.25..130.875.
      expect(boxes(result)).toEqual({ code: [56.06, 75.19, 86.53, 98.16] });
    });
  }, 30_000);
});

describe('the collector reports outermost svgs only', () => {
  test('an svg inside another svg is not reported on its own', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="up"><div data-gt="barcode" data-gt-id="code" style="width:60px;height:30px">
           <svg width="60" height="20">${bars}<svg x="10" y="2" width="20" height="10"><rect width="20" height="10"/></svg></svg>
           <svg width="30" height="10">${bars}</svg></div></div>`,
        css,
      );
      const measured = (await page.evaluate(
        `(${collect.toString()})()`,
      )) as Measurement;
      // Reading the nested 20 x 10 svg too would paint a second, smaller rect
      // of the same barcode, and pull edges flush with it onto a wrong place.
      expect(measured.elements).toHaveLength(1);
      expect(
        measured.elements[0]?.replaced?.map(({ kind, rect }) => [
          kind,
          rect.width,
          rect.height,
        ]),
      ).toEqual([
        ['svg', 60, 20],
        ['svg', 30, 10],
      ]);
    });
  }, 30_000);
});

describe('buildGroundTruth: replaced <svg> elements of a hand-made measurement', () => {
  function figure(patch: Partial<MeasuredElement>): MeasuredElement {
    return {
      type: 'image',
      id: 'figure',
      ref: null,
      splitFrom: null,
      page: 0,
      region: 'area',
      rect: { x: 10, y: 100.25, width: 90, height: 30.625 },
      text: '',
      nested: false,
      ...patch,
    };
  }

  function build(elements: MeasuredElement[]): Record<string, number[]> {
    return boxes(
      buildGroundTruth(
        { pages: [{ x: 0, y: 0, width: 800, height: 1120 }], elements },
        source,
      ),
    );
  }

  test('the kind picks the painting rule: the same rect ends short as an svg but rounds as an img', () => {
    const rect = { x: 74.25, y: 100.75, width: 40.375, height: 30.375 };
    expect(
      build([
        figure({ id: 'as-img', rect, replaced: [{ kind: 'img', rect }] }),
        figure({ id: 'as-svg', rect, replaced: [{ kind: 'svg', rect }] }),
      ]),
    ).toEqual({
      // img: 74..115 x 101..131 px. svg: x ends at 74 + 40.375 = 114.375.
      'as-img': [55.5, 75.75, 86.25, 98.25],
      'as-svg': [55.5, 75.75, 85.78, 98.25],
    });
  });

  test('the outermost painted edge wins between an img and an svg flush with the same side, in either order', () => {
    // Both span the block's 100.25..130.875 px: the img paints 100..131, the
    // svg 100..130.625. The bottom is the img's 131 whether it is listed
    // before or after the svg.
    const y = { y: 100.25, height: 30.625 };
    const image = { kind: 'img' as const, rect: { x: 20, width: 10, ...y } };
    const vector = { kind: 'svg' as const, rect: { x: 40, width: 10, ...y } };
    expect(
      build([
        figure({ id: 'svg-first', replaced: [vector, image] }),
        figure({ id: 'img-first', replaced: [image, vector] }),
      ]),
    ).toEqual({
      'svg-first': [7.5, 75, 75, 98.25],
      'img-first': [7.5, 75, 75, 98.25],
    });
  });

  test('an svg that is not flush but paints further out than the flush one still grows the box', () => {
    // Block 73.625..114.625 px wide. A (74.25..114.625) is flush right and
    // paints to 74 + 40.375 = 114.375; B (73.625..114.5625) is flush left,
    // not flush right, and paints to min(74 + 40.9375, 115) = 114.9375. The
    // right edge snaps to A's 114.375 and then grows to B's 114.9375; growing
    // first and snapping after would leave 114.375. Top and bottom: both
    // span the block's 100.25..130.875 and paint 100..130.625.
    const y = { y: 100.25, height: 30.625 };
    expect(
      build([
        figure({
          rect: { x: 73.625, width: 41, ...y },
          replaced: [
            { kind: 'svg', rect: { x: 74.25, width: 40.375, ...y } },
            { kind: 'svg', rect: { x: 73.625, width: 40.9375, ...y } },
          ],
        }),
      ]),
    ).toEqual({ figure: [55.5, 75, 86.2, 97.97] });
  });

  test('a block grows to the painted svg when it paints past the block', () => {
    // Block 74.75..114.875 px wide; the svg is 74.75..114.75, so it is flush
    // left (paints from 75) and not flush right, yet paints to
    // min(75 + 40, 115) = 115, past the block's 114.875. Vertically it is the
    // whole block and paints 100..130.625.
    const rect = { x: 74.75, y: 100.25, width: 40, height: 30.625 };
    expect(
      build([
        figure({
          rect: { ...rect, width: 40.125 },
          replaced: [{ kind: 'svg', rect }],
        }),
      ]),
    ).toEqual({ figure: [56.25, 75, 86.25, 97.97] });
  });
});
