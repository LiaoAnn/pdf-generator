// T08-5 slice 1: a decoration counts only where Chrome really paints it.
// Probed on local Chromium 153 (printed PDF, vector and raster): an element
// with opacity 0, or inside one, prints nothing at all (no drawing
// operators), while opacity 0.01 is still drawn. A clip-path, the element's
// own or an ancestor's, cuts what it paints at the clip region's exact,
// unrounded edges: the ink is the decoration painted on whole px (as T08-3
// and T08-4 found) intersected with that region, and a region that is
// empty (inset(50%)) prints nothing. inset() regions are computed exactly;
// any other shape (circle(), polygon(), url()) is not, and keeps today's
// box, which covers the ink. Offsets are multiples of 1/64 px and avoid
// exact .5 fractions, so every expected box is exact: px * 0.75, two
// decimals.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-visible',
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

// @page 600pt x 800pt with 60pt 48pt margins: the content area starts at
// (64, 80) px of its page.
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
  .fill { background: #000; }
  .small { width: 40.5px; height: 30.5px; }
  .full { width: 100%; height: 100%; }`;

/** The .small box as laid out: nothing painted moves it. */
const layoutBox = [55.69, 75.56, 86.06, 98.44];
/** The .small box with a background painted on whole px: 74..115 x 101..131. */
const paintedBox = [55.5, 75.75, 86.25, 98.25];

async function read(
  page: Page,
  body: string,
  extraCss = '',
): Promise<Record<string, number[]>> {
  await paginate(page, body, `${css}\n${extraCss}`);
  const result = await readGroundTruth(page, source);
  expect(gtSchema.parse(result)).toEqual(result);
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

describe('readGroundTruth: opacity 0 paints nothing', () => {
  test('a block with a background and opacity 0 keeps its layout box', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="hidden" class="fill small" style="opacity: 0"></div></div>`,
        ),
      ).toEqual({ hidden: layoutBox });
    });
  }, 30_000);

  test('opacity 0 on an ancestor outside the block hides its background too', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<div class="pad"><div style="opacity: 0"><div data-gt="paragraph" data-gt-id="under" class="fill small"></div></div></div>`,
        ),
      ).toEqual({ under: layoutBox });
    });
  }, 30_000);

  test('a background or <svg> inside the block under an opacity 0 wrapper moves no side', async () => {
    await withPage(async page => {
      // Painted, the child background would move every side to 74..115 x
      // 101..131 and the <svg> its left, top and bottom sides.
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="inner" class="small">
             <div class="full" style="opacity: 0"><div class="fill full"></div></div></div></div>
           <div class="pad"><div data-gt="image" data-gt-id="svg" class="small">
             <svg class="full" style="display: block; opacity: 0"><rect width="10" height="10"/></svg></div></div>`,
        ),
      ).toEqual({
        inner: layoutBox,
        // The second .pad: 74.25..114.75 x 152..182.5 px as laid out.
        svg: [55.69, 114, 86.06, 136.88],
      });
    });
  }, 30_000);

  test('an outline on a block with opacity 0 does not grow its box', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="ring" class="small" style="outline: 3px solid #000; opacity: 0"></div></div>`,
        ),
      ).toEqual({ ring: layoutBox });
    });
  }, 30_000);

  test('opacity 0.01 is still printed: the background moves the box as usual', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="faint" class="fill small" style="opacity: 0.01"></div></div>`,
        ),
      ).toEqual({ faint: paintedBox });
    });
  }, 30_000);
});

describe('readGroundTruth: a clip-path cuts what it paints at exact edges', () => {
  test('a background clipped away entirely (inset(50%)) keeps the layout box', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="gone" class="fill small" style="clip-path: inset(50%)"></div></div>`,
        ),
      ).toEqual({ gone: layoutBox });
    });
  }, 30_000);

  test('inset(0) prints the whole-px background cut at the unrounded border box', async () => {
    await withPage(async page => {
      // 74..115 x 101..131 cut to 74.25..114.75 x 100.75..131.25:
      // 74.25..114.75 x 101..131 px.
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="cut" class="fill small" style="clip-path: inset(0)"></div></div>`,
        ),
      ).toEqual({ cut: [55.69, 75.75, 86.06, 98.25] });
    });
  }, 30_000);

  test('a background clipped by a wrapper inside the block moves only the sides it still reaches', async () => {
    await withPage(async page => {
      // The wrapper's clip starts 10 px in: the background's ink is
      // 84.25..114.75 x 101..131 px, so the block keeps its own left edge
      // (74.25) and takes the ink's top, right and bottom.
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="part" class="small">
             <div class="full" style="clip-path: inset(0 0 0 10px)"><div class="fill full"></div></div></div></div>`,
        ),
      ).toEqual({ part: [55.69, 75.75, 86.06, 98.25] });
    });
  }, 30_000);

  test('a box-shadow is cut at the clip-path’s unrounded edges', async () => {
    await withPage(async page => {
      // Shadow 69..120 x 96..136 px, clip the border box grown by 3.125:
      // 71.125..117.875 x 97.625..134.375 px.
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="shade" class="small"
             style="box-shadow: 0 0 0 5px #000; clip-path: inset(-3.125px)"></div></div>`,
        ),
      ).toEqual({ shade: [53.34, 73.22, 88.41, 100.78] });
    });
  }, 30_000);

  test('a single percentage inset is a share of the width across and of the height up and down', async () => {
    await withPage(async page => {
      // inset(-25%) on 40.5 x 30.5 px grows the region 10.125 px across and
      // 7.625 px up and down: 64.125..124.875 x 93.125..138.875 px, which
      // cuts the shadow (54..135 x 81..151 px) on every side.
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="share" class="small"
             style="box-shadow: 0 0 0 20px #000; clip-path: inset(-25%)"></div></div>`,
        ),
      ).toEqual({ share: [48.09, 69.84, 93.66, 104.16] });
    });
  }, 30_000);

  test('a clip-path on an ancestor outside the block cuts the block’s shadow', async () => {
    await withPage(async page => {
      // The wrapper spans 74.25..736 x 100.75..131.25 px: of the shadow
      // (69..120 x 96..136 px) only the part right of the block shows.
      expect(
        await read(
          page,
          `<div class="pad"><div style="clip-path: inset(0)"><div data-gt="paragraph" data-gt-id="side" class="small"
             style="box-shadow: 0 0 0 5px #000"></div></div></div>`,
        ),
      ).toEqual({ side: [55.69, 75.56, 90, 98.44] });
    });
  }, 30_000);

  test('a shape other than inset() is not computed: the background keeps the whole-px box, which covers its ink', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="round" class="fill small" style="clip-path: circle(50%)"></div></div>`,
        ),
      ).toEqual({ round: paintedBox });
    });
  }, 30_000);
});

describe('readGroundTruth: the pseudo-element rebuild guard covers opacity and clip-path', () => {
  test.each([
    ['opacity', '.hush { opacity: 0; } .hush:has(span) { opacity: 1; }'],
    [
      'clip-path',
      '.hush { clip-path: inset(50%); } .hush:has(span) { clip-path: none; }',
    ],
  ])(
    'a rebuild that would make the block’s background show through %s measures the page as printed',
    async (_name, rule) => {
      await withPage(async page => {
        // A child span in the block would make its background print; the
        // printed page has none, so nothing it paints is measured.
        expect(
          await read(
            page,
            `<div class="pad"><div data-gt="list_item" data-gt-id="guarded" class="fill small hush mark"></div></div>`,
            `.mark::before { content: "x"; background: #000; } ${rule}`,
          ),
        ).toEqual({ guarded: layoutBox });
      });
    },
    30_000,
  );
});
