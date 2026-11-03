// T08-6 slice 1: what an element inside a block paints counts for the block
// even where it sticks out of the block's border box (a negative margin, an
// absolutely positioned child): its background and borders (T08-3), its
// <img> or <svg> (T08-2) grow the box to their painted edges, but only as
// far as the overflow clips around them let them show (T08-5's clips:
// whole px of the page) and a clip-path's region (exact edges). A side the
// visible part of such a child lies flush with takes the child's painted
// edge, as one inside the box does. Offsets are multiples of 1/64 px
// (Chrome's layout unit) and avoid exact .5 fractions, so every expected
// box is exact: px edge * 0.75, two decimals. Slice 2: an <img> or <svg>
// whose computed visibility is not visible paints nothing at all.
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
  templateId: 'painted-descendant',
  templateVersion: 1,
  seed: 'T08-6',
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
// with 60pt 48pt margins: the content area is 64..736 px wide and starts at
// y 80 px of its page.
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
const bars = `<rect width="100%" height="100%" fill="black"/>`;

// Puts its child 10.25 px right of and 20.75 px below the content area's
// corner: a .small block's border box is 74.25..114.75 x 100.75..131.25 px
// of its page, rounded 74..115 x 101..131; it paints nothing itself.
const css = `.pad { padding: 20.75px 0 0 10.25px; }
  .small { position: relative; width: 40.5px; height: 30.5px; }
  .clipped { overflow: hidden; }
  .next { break-before: page; }
  /* A band 12.25 px left of the block, along its top: 62..114.75 x
     100.75..111 px, painted 62..115 x 101..111. */
  .band { margin-left: -12.25px; height: 10.25px; background: #000; }
  /* The same as an image: 62..82.5 x 100.75..111 px, painted 62..83 x 101..111. */
  .wide { display: block; margin-left: -12.25px; width: 20.5px; height: 10.25px; }`;

/** The .small box with nothing painted: its layout edges in pt. */
const layoutBox = [55.69, 75.56, 86.06, 98.44];

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

async function read(
  page: Page,
  body: string,
  extra = '',
): Promise<GroundTruth> {
  await paginate(page, body, `${css} ${extra}`);
  return readGroundTruth(page, source);
}

describe('readGroundTruth: a background or border inside a block that sticks out of it', () => {
  test('a band past the block’s left grows the box to its painted edge and moves the sides it lies flush with, on page 2 as on page 1', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="banded" class="small"><div class="band"></div></div></div>
         <div class="pad next"><div data-gt="paragraph" data-gt-id="banded2" class="small"><div class="band"></div></div></div>`,
      );
      // Left grows to 62 px; the band is flush with the top (101) and the
      // right (115); the bottom keeps its layout edge.
      expect(result.blocks.map(b => b.page)).toEqual([1, 2]);
      expect(boxes(result)).toEqual({
        banded: [46.5, 75.75, 86.25, 98.44],
        banded2: [46.5, 75.75, 86.25, 98.44],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('an absolutely positioned frame that paints only borders past the bottom right grows the box to the borders’ painted edges', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="framed" class="small"><div class="frame"></div></div></div>`,
        // 94.625..125.125 x 126.125..138.625 px, painted 95..125 x 126..139.
        `.frame { position: absolute; left: 20.375px; top: 25.375px; width: 30.5px;
           height: 12.5px; border-right: 2px solid #000; border-bottom: 2px solid #000; }`,
      );
      expect(boxes(result)).toEqual({ framed: [55.69, 75.56, 93.75, 104.25] });
    });
  }, 30_000);

  test('the block’s own overflow clip cuts the band at the clip’s painted edge', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="cut" class="small clipped"><div class="band"></div></div></div>`,
      );
      // The clip is the block's padding box, painted 74..115 x 101..131: the
      // band shows 74..115 x 101..111, flush with the left, top and right.
      expect(boxes(result)).toEqual({ cut: [55.5, 75.75, 86.25, 98.44] });
    });
  }, 30_000);

  test('an overflow clip on an ancestor outside the block cuts the band too', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div class="wrap"><div data-gt="paragraph" data-gt-id="wrapped" class="small"><div class="band"></div></div></div></div>`,
        // The wrapper's padding box starts 5.5 px left of the block: 68.75
        // px, painted from 69. The band shows 69..115 x 101..111.
        `.wrap { overflow: hidden; margin-left: -5.5px; padding-left: 5.5px; }`,
      );
      expect(boxes(result)).toEqual({ wrapped: [51.75, 75.75, 86.25, 98.44] });
    });
  }, 30_000);

  test('a clip on one axis only cuts that axis: overflow-x clip stops the left, not the bottom', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="axis" class="small" style="overflow-x: clip"><div class="drop"></div></div></div>`,
        // 66..78.5 x 121..141.375 px, painted 66..79 x 121..141; the clip
        // leaves 74..79 x 121..141, flush with the block's left.
        `.drop { position: absolute; left: -8.25px; top: 20.25px; width: 12.5px;
           height: 20.375px; background: #000; }`,
      );
      expect(boxes(result)).toEqual({ axis: [55.5, 75.56, 86.06, 105.75] });
    });
  }, 30_000);

  test('a clip-path on the band cuts it at the region’s exact edges', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="masked" class="small"><div class="band masked"></div></div></div>`,
        // The region is 66.125..114.75 x 100.75..111 px: the ink is
        // 66.125..114.75 x 101..111, flush with the top and the right.
        `.masked { clip-path: inset(0 0 0 4.125px); }`,
      );
      expect(boxes(result)).toEqual({ masked: [49.59, 75.75, 86.06, 98.44] });
    });
  }, 30_000);

  test.each([
    [
      'cut away entirely by the block’s overflow clip',
      'clipped',
      `.child { position: absolute; left: -20.25px; top: 4.25px; width: 6.25px;
         height: 6.25px; background: #000; }`,
    ],
    [
      'made invisible by opacity 0',
      '',
      `.child { margin-left: -12.25px; height: 10.25px; background: #000; opacity: 0; }`,
    ],
  ])(
    'a child %s moves no side',
    async (_, extraClass, style) => {
      await withPage(async page => {
        const result = await read(
          page,
          `<div class="pad"><div data-gt="paragraph" data-gt-id="quiet" class="small ${extraClass}"><div class="child"></div></div></div>`,
          style,
        );
        expect(boxes(result)).toEqual({ quiet: layoutBox });
      });
    },
    30_000,
  );
});

describe('readGroundTruth: an <img> or <svg> inside a block that sticks out of it', () => {
  test('an img past the block’s left grows the box to its painted edge and moves the top it lies flush with, on page 2 as on page 1', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="pic" class="small"><img class="wide" alt="" src="${gray}"></div></div>
         <div class="pad next"><div data-gt="image" data-gt-id="pic2" class="small"><img class="wide" alt="" src="${gray}"></div></div>`,
      );
      expect(result.blocks.map(b => b.page)).toEqual([1, 2]);
      expect(boxes(result)).toEqual({
        pic: [46.5, 75.75, 86.06, 98.44],
        pic2: [46.5, 75.75, 86.06, 98.44],
      });
    });
  }, 30_000);

  test('an absolutely positioned img past the bottom grows the box to its painted bottom', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="low" class="small"><img class="drop" alt="" src="${gray}"></div></div>`,
        // 84.625..104.875 x 126.125..138.375 px, painted 85..105 x 126..138.
        `.drop { position: absolute; left: 10.375px; top: 25.375px; width: 20.25px; height: 12.25px; }`,
      );
      expect(boxes(result)).toEqual({ low: [55.69, 75.56, 86.06, 103.5] });
    });
  }, 30_000);

  test('an absolutely positioned svg past the right grows the box to where the svg paints: from its rounded origin at its own size, cut to its rounded box', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="tick" class="small"><svg class="tick" width="20.375" height="10.25">${bars}</svg></div></div>`,
        // 104.625..125 x 105..115.25 px: from 105 for 20.375 px, cut to
        // round(125) = 125.
        `.tick { display: block; position: absolute; left: 30.375px; top: 4.25px; }`,
      );
      expect(boxes(result)).toEqual({ tick: [55.69, 75.56, 93.75, 98.44] });
    });
  }, 30_000);

  test('the block’s own overflow clip cuts the img at the clip’s painted edge', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="cutpic" class="small clipped"><img class="wide" alt="" src="${gray}"></div></div>`,
      );
      // It shows 74..83 x 101..111, flush with the left and the top.
      expect(boxes(result)).toEqual({ cutpic: [55.5, 75.75, 86.06, 98.44] });
    });
  }, 30_000);
});

describe('readGroundTruth: a hidden <img> or <svg> paints nothing', () => {
  test.each([
    ['an img', `<img class="fill hidden" alt="" src="${gray}">`],
    [
      'an svg',
      `<svg class="fill hidden" width="40.5" height="30.5">${bars}</svg>`,
    ],
  ])(
    '%s with visibility hidden that fills the block moves no side',
    async (_, child) => {
      await withPage(async page => {
        const result = await read(
          page,
          `<div class="pad"><div data-gt="image" data-gt-id="ghost" class="small">${child}</div></div>`,
          // Visible, either would snap every side to 74..115 x 101..131.
          `.fill { display: block; width: 40.5px; height: 30.5px; }
           .hidden { visibility: hidden; }`,
        );
        expect(boxes(result)).toEqual({ ghost: layoutBox });
      });
    },
    30_000,
  );

  test('an img past the block’s left inside a visibility: hidden parent moves no side', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="image" data-gt-id="ghost2" class="small"><div style="visibility: hidden"><img class="wide" alt="" src="${gray}"></div></div></div>`,
      );
      expect(boxes(result)).toEqual({ ghost2: layoutBox });
    });
  }, 30_000);
});

describe('buildGroundTruth: a painted entry outside the block, from a hand-made measurement', () => {
  function block(patch: Partial<MeasuredElement>): MeasuredElement {
    return {
      type: 'paragraph',
      id: 'block',
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

  function build(elements: MeasuredElement[]): Record<string, number[]> {
    const pages: Measurement['pages'] = [
      { x: 0, y: 0, width: 800, height: 1066.671875 },
    ];
    return boxes(buildGroundTruth({ pages, elements }, source));
  }

  test('a background outside the box grows it to its painted edge, cut to the measured clip rounded to whole px', () => {
    // 62..82.5 x 110.375..120.625 px, painted 62..83 x 110..121: inside the
    // box vertically, so only the left moves. The clip's left, 68.75 px,
    // paints at 69.
    const rect = { x: 62, y: 110.375, width: 20.5, height: 10.25 };
    const clip = { x: 68.75, y: 0, width: 700, height: 1000 };
    expect(
      build([
        block({ id: 'free', painted: [{ kind: 'box', rect }] }),
        block({ id: 'cut', painted: [{ kind: 'box', rect, clip }] }),
      ]),
    ).toEqual({
      free: [46.5, 75.56, 86.06, 98.44],
      cut: [51.75, 75.56, 86.06, 98.44],
    });
  });

  test('an entry its clip hides entirely moves no side', () => {
    const rect = { x: 62, y: 110.375, width: 10.5, height: 10.25 };
    const clip = { x: 74.25, y: 100.75, width: 40.5, height: 30.5 };
    expect(build([block({ painted: [{ kind: 'box', rect, clip }] })])).toEqual({
      block: [55.69, 75.56, 86.06, 98.44],
    });
  });
});
