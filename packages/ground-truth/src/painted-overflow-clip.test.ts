// T08-5 slice 4: overflow clips as Chrome prints them. Probed on local
// Chromium 153 (printed PDF, vector and raster): an overflow clip is a rect
// on whole px of the page. overflow-clip-margin moves it out from the
// padding box (or from the box it names: border-box, content-box), but only
// when both axes are overflow: clip or the element has paint containment;
// with overflow: hidden, or clip on one axis only, the margin is ignored.
// Paint containment (contain: paint, strict or content, and
// content-visibility: auto) clips both axes at the padding box like
// overflow: clip. Neither overflow nor contain clips anything on an inline
// box or a table row. Inside paint containment Chrome rounds from the
// container's own origin, not the page's (T08-7 proposed), so the contain
// cases put the container on whole px, where the two agree. Every block is
// a 10 px dot with a 30 px shadow spread that overflows its container on
// every side; the expected box is that shadow cut by the clip.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-overflow-clip',
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

// .pad puts the container at (74.25, 100.75) px of its page, .whole at
// (74, 101). The container is 60.375 x 50.375 px with a 2 px transparent
// border and 3.125 px padding, so in .pad its border box is 74.25..134.625
// x 100.75..151.125, its padding box 76.25..132.625 x 102.75..149.125 and
// its content box 79.375..129.5 x 105.875..146; in .whole the padding box
// is 76..132.375 x 103..149.375. The dot is 10 x 10 px at the content box's
// corner (79.375.. or 79.125..), painted 79..89 x 106..116 either way, so
// its shadow spans 49..119 x 76..146 px.
const css = `.pad { padding: 20.75px 0 0 10.25px; }
  .whole { padding: 21px 0 0 10px; }
  .box { width: 60.375px; height: 50.375px; border: 2px solid transparent; padding: 3.125px; }
  .dot { width: 10px; height: 10px; box-shadow: 0 0 0 30px #000; }`;

/** The dot's shadow cut at the container's padding box, rounded: 76..119 x 103..146 px. */
const paddingCut = [57, 77.25, 89.25, 109.5];
/** The same grown 10 px by overflow-clip-margin: 66..119 x 93..146 px. */
const marginCut = [49.5, 69.75, 89.25, 109.5];

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

/** A dot block in a .box container with the given style, inside a .pad or .whole. */
const contained = (style: string, pad = 'pad') =>
  `<div class="${pad}"><div class="box" style="${style}"><div data-gt="paragraph" data-gt-id="dot" class="dot"></div></div></div>`;

/** The block's own shadow, uncut: its rounded layout box grown by 30 px, in pt. */
async function uncut(page: Page, id: string): Promise<number[]> {
  const layout = await page.evaluate(gtId => {
    const element = document.querySelector(`[data-gt-id="${gtId}"]`);
    const sheet = element?.closest('.pagedjs_page');
    if (!element || !sheet) throw new Error(`no ${gtId}`);
    const r = element.getBoundingClientRect();
    const p = sheet.getBoundingClientRect();
    return [r.left - p.left, r.top - p.top, r.right - p.left, r.bottom - p.top];
  }, id);
  return layout.map(
    (px, i) =>
      Math.round((Math.round(px) + (i < 2 ? -30 : 30)) * 0.75 * 100) / 100,
  );
}

describe('readGroundTruth: overflow-clip-margin moves an overflow: clip', () => {
  test('overflow: clip with a 10px clip margin cuts 10 px outside the padding box', async () => {
    await withPage(async page => {
      // Padding box grown by 10: 66.25..142.625 x 92.75..159.125, on whole
      // px 66..143 x 93..159.
      expect(
        await read(
          page,
          contained('overflow: clip; overflow-clip-margin: 10px'),
        ),
      ).toEqual({ dot: marginCut });
    });
  }, 30_000);

  test('overflow-clip-margin: border-box cuts at the border box, content-box at the content box', async () => {
    await withPage(async page => {
      // Border box on whole px 74..135 x 101..151.
      expect(
        await read(
          page,
          contained('overflow: clip; overflow-clip-margin: border-box'),
        ),
      ).toEqual({ dot: [55.5, 75.75, 89.25, 109.5] });
      // Content box from 79.375 x 105.875 px, on whole px from 79 x 106:
      // the shadow shows only from 79 and 106, and the dot itself starts
      // at 105.875 px.
      expect(
        await read(
          page,
          contained('overflow: clip; overflow-clip-margin: content-box'),
        ),
      ).toEqual({ dot: [59.25, 79.41, 89.25, 109.5] });
    });
  }, 30_000);

  test('with overflow: hidden the clip margin is ignored: the cut stays at the padding box', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          contained('overflow: hidden; overflow-clip-margin: 10px'),
        ),
      ).toEqual({ dot: paddingCut });
    });
  }, 30_000);

  test('with overflow: clip on one axis only the margin is ignored and the other axis is not cut', async () => {
    await withPage(async page => {
      // Cut at the padding box's 76 and 133 px across; up and down the
      // shadow's own 76..146 px.
      expect(
        await read(
          page,
          contained(
            'overflow-x: clip; overflow-y: visible; overflow-clip-margin: 10px',
          ),
        ),
      ).toEqual({ dot: [57, 57, 89.25, 109.5] });
    });
  }, 30_000);
});

describe('readGroundTruth: paint containment clips like overflow: clip', () => {
  test.each([
    ['contain: paint', 'contain: paint'],
    ['contain: strict', 'contain: strict'],
    ['contain: content', 'contain: content'],
    ['content-visibility: auto', 'content-visibility: auto'],
  ])(
    '%s cuts the shadow at the padding box',
    async (_name, style) => {
      await withPage(async page => {
        // Padding box 76..132.375 x 103..149.375 px, on whole px 76..132 x
        // 103..149.
        expect(await read(page, contained(style, 'whole'))).toEqual({
          dot: paddingCut,
        });
      });
    },
    30_000,
  );

  test('contain: paint honours overflow-clip-margin', async () => {
    await withPage(async page => {
      // 66..142.375 x 93..159.375 px, on whole px 66..142 x 93..159.
      expect(
        await read(
          page,
          contained('contain: paint; overflow-clip-margin: 10px', 'whole'),
        ),
      ).toEqual({ dot: marginCut });
    });
  }, 30_000);
});

describe('readGroundTruth: inline boxes and table rows clip nothing', () => {
  test.each([
    [
      'an inline span with overflow: hidden',
      `<div class="pad"><span style="overflow: hidden"><span data-gt="paragraph" data-gt-id="dot" class="dot" style="display: inline-block"></span></span></div>`,
    ],
    [
      'an inline span with contain: paint',
      `<div class="pad"><span style="contain: paint"><span data-gt="paragraph" data-gt-id="dot" class="dot" style="display: inline-block"></span></span></div>`,
    ],
    [
      'a table row with contain: paint',
      `<div class="pad"><table style="border-collapse: collapse"><tr style="contain: paint"><td style="padding: 0"><div data-gt="paragraph" data-gt-id="dot" class="dot"></div></td></tr></table></div>`,
    ],
  ])(
    '%s leaves the shadow whole',
    async (_name, body) => {
      await withPage(async page => {
        const result = await read(page, body);
        expect(result).toEqual({ dot: await uncut(page, 'dot') });
      });
    },
    30_000,
  );
});

describe('readGroundTruth: the pseudo-element rebuild guard covers contain and overflow-clip-margin', () => {
  test.each([
    [
      'contain',
      '.wrap { contain: paint; } .wrap:has(span) { contain: none; }',
      paddingCut,
    ],
    [
      'overflow-clip-margin',
      '.wrap { overflow: clip; overflow-clip-margin: 10px; } .wrap:has(span) { overflow-clip-margin: 0px; }',
      marginCut,
    ],
  ])(
    'a rebuild that would change the container’s %s measures the page as printed',
    async (_name, rule, expected) => {
      await withPage(async page => {
        // A span anywhere in the container would change its clip; the
        // printed page has none, so no pseudo-element is measured.
        expect(
          await read(
            page,
            `<div class="whole"><div class="box wrap"><div data-gt="list_item" data-gt-id="dot" class="dot mark"></div></div></div>`,
            `.mark::before { content: "x"; background: #000; } ${rule}`,
          ),
        ).toEqual({ dot: expected });
      });
    },
    30_000,
  );
});
