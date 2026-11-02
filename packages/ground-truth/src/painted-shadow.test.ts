// T08-4 slice 2: an outer box-shadow paints outside the border box, so the gt
// box of a block grows to cover it (the shadow of the block itself or of
// anything inside it). Chrome paints the shadow's shape at the border box
// rounded to whole CSS px of the printed page, moved by its offset and grown
// by its spread (neither rounded), and only outside that rounded border box.
// A blur is printed as an image reaching 1.4–1.6 × the blur radius past the
// shape (probed on local Chromium for blurs of 1 to 30 px); the box counts
// it to 1.5 × the blur radius, three standard deviations of the Gaussian CSS
// defines (σ = blur / 2). An inset or transparent shadow adds nothing. An
// inline element broken over lines is shadowed as one box sliced at the line
// ends (box-decoration-break: slice): no shadow past a fragment's sliced
// sides. A shadow shows only inside the overflow clips around it.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-shadow',
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

async function shadowed(page: Page, shadow: string): Promise<number[]> {
  await paginate(
    page,
    `<div class="pad"><div data-gt="paragraph" data-gt-id="card" class="small"
        style="box-shadow: ${shadow}"></div></div>`,
    css,
  );
  const result = await readGroundTruth(page, source);
  return boxes(result).card ?? [];
}

const pt = (px: number) => Math.round(px * 0.75 * 100) / 100;

describe('readGroundTruth: an outer box-shadow is in its block’s box', () => {
  test('a spread grows the box from the rounded border box by the unrounded spread, on page 2 as on page 1', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="spread" class="small"
            style="box-shadow: 0 0 0 3.25px #000"></div></div>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="spread2" class="small"
            style="box-shadow: 0 0 0 3.25px #000"></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // 74..115 x 101..131 grown by 3.25: 70.75..118.25 x 97.75..134.25 px
      // on each page (page 2 starts at 1066.67 px).
      expect(result.blocks.map(b => b.page)).toEqual([1, 2]);
      expect(boxes(result)).toEqual({
        spread: [53.06, 73.31, 88.69, 100.69],
        spread2: [53.06, 73.31, 88.69, 100.69],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('an offset moves the shape: only the sides it passes grow, the others keep the layout edge', async () => {
    await withPage(async page => {
      // Shape 78.25..119.25 x 106.25..136.25 px: past the right and bottom.
      expect(await shadowed(page, '4.25px 5.25px 0 0 #000')).toEqual([
        55.69, 75.56, 89.44, 102.19,
      ]);
    });
  }, 30_000);

  test('a blur reaches 1.5 × its radius past the moved and spread shape', async () => {
    await withPage(async page => {
      // Shape 75..118 x 103..135 px (offset 2, 3, spread 1), plus 9.
      expect(await shadowed(page, '2px 3px 6px 1px #000')).toEqual([
        49.5, 70.5, 95.25, 108,
      ]);
    });
  }, 30_000);

  test.each([
    ['no spread, offset or blur', '0 0 0 0 #000'],
    ['a negative spread', '0 0 0 -2px #000'],
    ['an inset shadow', 'inset 0 0 0 20px #000'],
    ['a transparent shadow', '0 0 0 30px transparent'],
    ['zero alpha in slash syntax', '0 0 0 30px rgb(0 0 0 / 0)'],
  ])(
    'a shadow that paints nothing outside the rounded border box (%s) moves no side',
    async (_, shadow) => {
      await withPage(async page => {
        expect(await shadowed(page, shadow)).toEqual(layoutBox);
      });
    },
    30_000,
  );

  test('of several shadows, each one that paints counts and the others don’t', async () => {
    await withPage(async page => {
      // Only the last paints outside: shape 77.25..118.25 x 101..131 px.
      expect(
        await shadowed(
          page,
          'inset 0 0 0 20px #000, 0 0 0 30px rgba(0, 0, 0, 0), 3.25px 0 0 0 #000',
        ),
      ).toEqual([55.69, 75.56, 88.69, 98.44]);
    });
  }, 30_000);

  test('two shadows reaching past opposite sides each grow their own side', async () => {
    await withPage(async page => {
      // One 5.25 px left (68.75 at the left), one 6.25 px down (137.25 at
      // the bottom, and as wide as the rounded box: 74..115): each decides
      // the side it passes.
      expect(
        await shadowed(page, '-5.25px 0 0 0 #000, 0 6.25px 0 0 #000'),
      ).toEqual([51.56, 75.56, 86.25, 102.94]);
    });
  }, 30_000);

  test('an <svg> block’s own shadow counts as an element’s does', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><svg data-gt="image" data-gt-id="drawing" class="small"
            style="display: block; box-shadow: 0 0 0 2.25px #000" viewBox="0 0 40 30">
            <rect width="40" height="30" fill="#00f"/></svg></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // 74..115 x 101..131 grown by 2.25: 71.75..117.25 x 98.75..133.25 px.
      expect(boxes(result)).toEqual({
        drawing: [53.81, 74.06, 87.94, 99.94],
      });
    });
  }, 30_000);

  test('a hidden block’s shadow moves no side', async () => {
    await withPage(async page => {
      expect(
        await shadowed(page, '0 0 0 3.25px #000; visibility: hidden'),
      ).toEqual(layoutBox);
    });
  }, 30_000);

  test('the shadow of an element inside the block counts too', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="holder" class="small">
           <div style="height: 100%; box-shadow: 0 0 0 2px #000"></div></div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      expect(boxes(result)).toEqual({ holder: [54, 74.25, 87.75, 99.75] });
    });
  }, 30_000);

  test('a shadow wholly hidden by an overflow clip at the block’s own edges moves no side', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div class="small" style="overflow: hidden">
           <div data-gt="paragraph" data-gt-id="hidden" style="height: 100%; box-shadow: 0 0 0 3.25px #000"></div>
         </div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      expect(boxes(result)).toEqual({ hidden: layoutBox });
    });
  }, 30_000);

  test('a shadow moved wholly below the box and clipped there adds nothing beside the box', async () => {
    await withPage(async page => {
      // The clip reaches 10 px past the block on the left and right but not
      // below it; the shadow (spread 3) lies wholly below the block, so the
      // clip hides all of it: no side moves.
      await paginate(
        page,
        `<div class="pad"><div style="overflow: hidden; padding: 0 10px; width: 60.5px; height: 30.5px">
           <div data-gt="paragraph" data-gt-id="below" style="height: 100%; box-shadow: 0 40px 0 3px #000"></div>
         </div></div>`,
        css,
      );
      const result = await readGroundTruth(page, source);
      // Block 84.25..124.75 x 100.75..131.25 px.
      expect(boxes(result)).toEqual({ below: [63.19, 75.56, 93.56, 98.44] });
    });
  }, 30_000);

  test.each([
    ['slice', 'slice'],
    ['clone', 'clone'],
  ])(
    'an inline element broken over lines (box-decoration-break: %s) is shadowed per line box as Chrome slices or clones it',
    async (_, mode) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div class="pad"><p data-gt="paragraph" data-gt-id="wrapped" style="width: 60.5px">xx
           <span id="mark" style="box-shadow: 0 0 0 3px #000; box-decoration-break: ${mode}">aaa bbb ccc ddd eee</span></p></div>`,
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
        // Left to right: a fragment's left is sliced unless it is the first,
        // its right unless it is the last; a sliced side gets no shadow.
        const union = (sliced: boolean) => {
          const last = measured.lines.length - 1;
          const shapes = measured.lines.map(
            ([x0 = 0, y0 = 0, x1 = 0, y1 = 0], k) => [
              Math.round(x0) - (sliced && k > 0 ? 0 : 3),
              Math.round(y0) - 3,
              Math.round(x1) + (sliced && k < last ? 0 : 3),
              Math.round(y1) + 3,
            ],
          );
          const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = measured.block;
          return [
            Math.min(b0, ...shapes.map(o => o[0] ?? 0)),
            Math.min(b1, ...shapes.map(o => o[1] ?? 0)),
            Math.max(b2, ...shapes.map(o => o[2] ?? 0)),
            Math.max(b3, ...shapes.map(o => o[3] ?? 0)),
          ].map(pt);
        };
        // The later lines start at the paragraph's left edge: slicing decides
        // whether the shadow reaches past it, so the test tells them apart.
        expect(union(true)).not.toEqual(union(false));
        const result = await readGroundTruth(page, source);
        expect(boxes(result).wrapped).toEqual(union(mode === 'slice'));
      });
    },
    30_000,
  );
});
