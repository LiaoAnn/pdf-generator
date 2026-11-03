// T08-7: inside paint containment Chrome rounds what it paints from the
// container's own origin, not the page's. Probed on local Chromium 153
// (printed PDF, 238 inked elements over 8 pages): a paint container is an
// element whose computed contain holds paint, strict or content, or whose
// content-visibility is auto or hidden (not an inline box). Containers form
// frames: with O the container's border-box origin on its page and P the
// enclosing frame's (the page: 0) at whole px F_P, the container's frame
// sits at F = F_P + round(O - P). Everything an element paints — its
// background, borders, <img>, <svg>, ::before/::after boxes, outline and
// box-shadow — is placed in the frame of the nearest paint container that
// is the element itself or an ancestor: an edge laid out at L paints at
// F + round(L - O), where page rounding gives round(L). Slice 1 covers
// what elements paint; the overflow clips and clip-path regions follow in
// slices 2 and 3. Offsets are multiples of 1/64 px (Chrome's layout unit)
// and avoid exact .5 fractions, so every expected box is exact: px edge *
// 0.75, two decimals.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-containment',
  templateVersion: 1,
  seed: 'T08-7',
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

// @page 600pt x 800pt (800 x 1066.67 px, so page 2 starts at a fractional px
// of the document) with 60pt 48pt margins: the content area starts at
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

// .at puts the container at O = (74.375, 100.625) px of its page, so its
// frame sits at F = (74, 101). A .spot is laid out 13.25 px right of and
// 5.75 px below O, 50.125 x 20 px: 87.625..137.75 x 106.375..126.375 px.
// In the frame it paints at 74 + round(13.25) = 87 .. 74 + round(63.375) =
// 137 and 101 + round(5.75) = 107 .. 101 + round(25.75) = 127; page
// rounding would give 88..138 x 106..126.
const css = `.at { padding: 20.625px 0 0 10.375px; }
  .c { width: 300px; height: 100px; }
  .paint { contain: paint; }
  .spot { margin: 5.75px 0 0 13.25px; width: 50.125px; height: 20px; }
  .ink { background: #000; }
  svg, img { display: block; }
  .next { break-before: page; }`;

/** The .spot painted in the container's frame: 87..137 x 107..127 px. */
const inFrame = [65.25, 80.25, 102.75, 95.25];
/** The .spot painted on whole px of the page: 88..138 x 106..126 px. */
const onPage = [66, 79.5, 103.5, 94.5];

const gray =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect width='4' height='4' fill='gray'/%3E%3C/svg%3E";

/** A block (with the given markup and classes) at .spot inside a container with the given style. */
const inside = (style: string, block: string) =>
  `<div class="at"><div class="c" style="${style}">${block}</div></div>`;

describe('readGroundTruth: what paints inside paint containment rounds from the container', () => {
  test.each([
    'contain: paint',
    'contain: strict',
    'contain: content',
    'content-visibility: auto',
  ])(
    'a background inside a container with %s snaps to the container’s frame',
    async style => {
      await withPage(async page => {
        expect(
          await read(
            page,
            inside(
              style,
              `<div data-gt="paragraph" data-gt-id="spot" class="spot ink"></div>`,
            ),
          ),
        ).toEqual({ spot: inFrame });
      });
    },
    30_000,
  );

  test('nested containers chain their frames: each one rounds from the one around it', async () => {
    await withPage(async page => {
      // Outer at (74.375, 100.625), frame (74, 101). Inner 3.375 x 2.625 px
      // further in: O = (77.75, 103.25), frame (74 + round(3.375), 101 +
      // round(2.625)) = (77, 104). The block, 13.375 x 4.625 px into the
      // inner one, 39.875 x 20 px: laid out 91.125..131 x 107.875..127.875
      // px, painted 77 + 13 = 90 .. 77 + round(53.25) = 130 and 104 + 5 =
      // 109 .. 104 + round(24.625) = 129. Page rounding: 91..131 x 108..128;
      // the outer frame alone: 91..131 x 108..128.
      expect(
        await read(
          page,
          inside(
            'contain: paint',
            `<div class="paint" style="margin: 2.625px 0 0 3.375px; width: 200px; height: 60px">
               <div data-gt="paragraph" data-gt-id="deep" class="ink" style="margin: 4.625px 0 0 13.375px; width: 39.875px; height: 20px"></div>
             </div>`,
          ),
        ),
      ).toEqual({ deep: [67.5, 81.75, 97.5, 96.75] });
    });
  }, 30_000);

  test('a paint container paints its own background in its own frame', async () => {
    await withPage(async page => {
      // The block is the container: O = (74.375, 100.625), 50.25 x 20.75 px.
      // Its own background paints at 74 .. 74 + round(50.25) = 124 and 101
      // .. 101 + round(20.75) = 122; page rounding gives 74..125 x 101..121.
      expect(
        await read(
          page,
          `<div class="at"><div data-gt="paragraph" data-gt-id="self" class="paint ink" style="width: 50.25px; height: 20.75px"></div></div>`,
        ),
      ).toEqual({ self: [55.5, 75.75, 93, 91.5] });
    });
  }, 30_000);

  test('borders, <img>, <svg> and ::before boxes inside a container paint in its frame', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          inside(
            'contain: paint',
            `<div data-gt="paragraph" data-gt-id="framed" class="spot" style="border: 3px solid #000"></div><div class="gap"></div>
             <img data-gt="image" data-gt-id="logo" alt="" src="${gray}" class="spot"><div class="gap"></div>
             <svg data-gt="image" data-gt-id="mark" class="spot" width="50.125" height="20"><rect width="100%" height="100%" fill="black"/></svg><div class="gap"></div>
             <div data-gt="paragraph" data-gt-id="lead" class="spot lead"></div>`,
          ),
          // Each block is 5.75 px margin, 20 px tall and 6.25 px gap: the
          // n-th one (from 0) lies 32n px below the first, so in the frame
          // it paints 107 + 32n .. 127 + 32n px (page rounding: 106 + 32n ..
          // 126 + 32n). The svg paints from its frame origin at its own
          // size, cut at its frame-rounded box (137 here, where its width
          // ends at 137.125). lead's ::before fills it.
          `.c { height: 400px; }
           .gap { height: 6.25px; }
           .lead::before { content: ''; display: block; height: 20px; background: #000; }`,
        ),
      ).toEqual({
        framed: inFrame,
        logo: [65.25, 104.25, 102.75, 119.25],
        mark: [65.25, 128.25, 102.75, 143.25],
        lead: [65.25, 152.25, 102.75, 167.25],
      });
    });
  }, 30_000);

  test('an outline and a box-shadow inside a container ring its frame-rounded box', async () => {
    await withPage(async page => {
      // The .spot rect in the frame is 87..137 x 107..127 px. A 2 px outline
      // paints 85..139 x 105..129; a 4 px spread shadow 83..141 x 103..131
      // (the container's clip, 74.375.. x 100.625.., is far enough away).
      // Page rounding would ring 88..138 x 106..126.
      expect(
        await read(
          page,
          inside(
            'contain: paint',
            `<div data-gt="paragraph" data-gt-id="ring" class="spot" style="outline: 2px solid #000"></div>`,
          ),
        ),
      ).toEqual({ ring: [63.75, 78.75, 104.25, 96.75] });
      expect(
        await read(
          page,
          inside(
            'contain: paint',
            `<div data-gt="paragraph" data-gt-id="halo" class="spot" style="box-shadow: 0 0 0 4px #000"></div>`,
          ),
        ),
      ).toEqual({ halo: [62.25, 77.25, 105.75, 98.25] });
    });
  }, 30_000);

  test('a child’s background sticking out of its block paints in the container’s frame (T08-6)', async () => {
    await withPage(async page => {
      // The block (no paint of its own) is the .spot; its first child sits
      // 6 px left of and 3 px above it, 20.25 x 10 px: laid out from
      // 81.625 x 103.375 px, painted from 74 + round(7.25) = 81 and 101 +
      // round(2.75) = 104 (page rounding: 82, 103). The block's right and
      // bottom are its own unrounded layout edges, 137.75 and 126.375 px.
      expect(
        await read(
          page,
          inside(
            'contain: paint',
            `<div data-gt="paragraph" data-gt-id="host" class="spot" style="display: flow-root">
               <div class="ink" style="margin: -3px 0 0 -6px; width: 20.25px; height: 10px"></div>
             </div>`,
          ),
        ),
      ).toEqual({ host: [60.75, 78, 103.31, 94.78] });
    });
  }, 30_000);

  test('a container on page 2 rounds from page 2’s corner like page 1', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          `<p data-gt="paragraph" data-gt-id="first">First page</p>
           <div class="next">${inside(
             'contain: paint',
             `<div data-gt="paragraph" data-gt-id="spot2" class="spot ink"></div>`,
           )}</div>`,
        ),
      ).toMatchObject({ spot2: inFrame });
    });
  }, 30_000);
});

describe('readGroundTruth: without paint containment the page rounds', () => {
  test.each([
    'contain: layout',
    'overflow: hidden',
    'will-change: transform',
    'position: relative; z-index: 1',
  ])(
    'a background inside a container with %s stays on whole px of the page',
    async style => {
      await withPage(async page => {
        expect(
          await read(
            page,
            inside(
              style,
              `<div data-gt="paragraph" data-gt-id="spot" class="spot ink"></div>`,
            ),
          ),
        ).toEqual({ spot: onPage });
      });
    },
    30_000,
  );

  test('contain: paint on an inline box contains nothing: its inline-block child rounds on the page', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="at"><span style="contain: paint">ab<span data-gt="paragraph" data-gt-id="chip" class="ink" style="display: inline-block; margin-left: 3.375px; width: 20.25px; height: 10px"></span></span></div>`,
      );
      // Where the line box puts the chip depends on the font; read its
      // layout and round each edge on the page.
      const layout = await page.evaluate(() => {
        const chip = document.querySelector('[data-gt-id="chip"]');
        const sheet = chip?.closest('.pagedjs_page');
        if (!chip || !sheet) throw new Error('no chip');
        const r = chip.getBoundingClientRect();
        const p = sheet.getBoundingClientRect();
        return [
          r.left - p.left,
          r.top - p.top,
          r.right - p.left,
          r.bottom - p.top,
        ];
      });
      expect(result).toEqual({
        chip: layout.map(px => Math.round(Math.round(px) * 0.75 * 100) / 100),
      });
    });
  }, 30_000);
});
