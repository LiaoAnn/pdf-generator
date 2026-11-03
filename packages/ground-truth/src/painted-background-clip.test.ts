// T08-5 slice 2: a background paints only its background-clip box. Probed on
// local Chromium 153 (printed PDF, vector and raster): with
// background-clip: padding-box or content-box the background is a rect on
// that box with each edge rounded to whole px on its own (as T08-3 found
// for the border box); with several layers each paints its own clip box
// (the color the last layer's), so the painted area is their union; with
// background-clip: text only the glyphs show, which is text, not a
// background. Semi-transparent borders, an element's own or a collapsed
// table cell's on the table's edge, are printed and count like opaque ones;
// fully transparent ones paint nothing. Offsets are multiples of 1/64 px and
// avoid exact .5 fractions, so every expected box is exact.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-background-clip',
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
  .small { width: 40.5px; height: 30.5px; }`;

/** The .small box as laid out: nothing painted moves it. */
const layoutBox = [55.69, 75.56, 86.06, 98.44];
/** The .small box with a background painted on whole px: 74..115 x 101..131. */
const paintedBox = [55.5, 75.75, 86.25, 98.25];
/**
 * The .small box whose painted background starts inside its left edge: the
 * left side keeps 74.25 px, the others take 101, 115 and 131 px.
 */
const leftInset = [55.69, 75.75, 86.25, 98.25];

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

/** One .small block in a .pad with the given inline style. */
const block = (id: string, style: string, text = '') =>
  `<div class="pad"><div data-gt="paragraph" data-gt-id="${id}" class="small" style="${style}">${text}</div></div>`;

/** A table's border box relative to its page, in pt: as laid out, or with each edge rounded to whole px. */
async function tableBox(
  page: Page,
  id: string,
  rounded: boolean,
): Promise<number[]> {
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
  return layout.map(
    px => Math.round((rounded ? Math.round(px) : px) * 0.75 * 100) / 100,
  );
}

describe('readGroundTruth: a background paints its background-clip box', () => {
  test('background-clip: padding-box inside a transparent left border leaves the left side as laid out', async () => {
    await withPage(async page => {
      // Padding box 76.25..114.75 x 100.75..131.25 px, painted 76..115 x
      // 101..131.
      expect(
        await read(
          page,
          block(
            'padding',
            'border-left: 2px solid transparent; background: #000; background-clip: padding-box',
          ),
        ),
      ).toEqual({ padding: leftInset });
    });
  }, 30_000);

  test('background-clip: content-box inside a left padding leaves the left side as laid out', async () => {
    await withPage(async page => {
      // Content box 77.5..114.75 x 100.75..131.25 px.
      expect(
        await read(
          page,
          block(
            'content',
            'padding-left: 3.25px; background: #000; background-clip: content-box',
          ),
        ),
      ).toEqual({ content: leftInset });
    });
  }, 30_000);

  test('background-clip: border-box is the whole border box, as before', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          block(
            'border',
            'border-left: 2px solid transparent; padding-left: 3.25px; background: #000; background-clip: border-box',
          ),
        ),
      ).toEqual({ border: paintedBox });
    });
  }, 30_000);

  test('several layers paint the union of their clip boxes; a transparent color adds nothing', async () => {
    await withPage(async page => {
      // Border box 74.25..114.75 x 100.75..131.25 px with a 2px transparent
      // top border and a 3.25px left padding: padding box 74.25..114.75 x
      // 102.75..131.25, content box 77.5..114.75 x 102.75..131.25. The
      // top side never shares a painted edge.
      expect(
        await read(
          page,
          block(
            'both',
            'border-top: 2px solid transparent; padding-left: 3.25px; background: linear-gradient(#000, #000) content-box, #000 padding-box',
          ),
        ),
      ).toEqual({ both: [55.5, 75.56, 86.25, 98.25] });
      expect(
        await read(
          page,
          block(
            'image',
            'border-top: 2px solid transparent; padding-left: 3.25px; background: linear-gradient(#000, #000) content-box, transparent padding-box',
          ),
        ),
      ).toEqual({ image: [55.69, 75.56, 86.25, 98.25] });
    });
  }, 30_000);

  test('background-clip: text paints only the glyphs: the box stays as laid out', async () => {
    await withPage(async page => {
      expect(
        await read(
          page,
          block(
            'text',
            'background: #000; background-clip: text; color: transparent',
            'Ab',
          ),
        ),
      ).toEqual({ text: layoutBox });
    });
  }, 30_000);

  test('the pseudo-element rebuild guard covers background-clip', async () => {
    await withPage(async page => {
      // As printed the background clips to the padding box inside a 2px
      // transparent left border; a child span in the block would paint it
      // over the border box.
      expect(
        await read(
          page,
          `<div class="pad"><div data-gt="list_item" data-gt-id="guarded" class="small hush mark"></div></div>`,
          `.mark::before { content: "x"; background: #000; }
           .hush { border-left: 2px solid transparent; background: #000; background-clip: padding-box; }
           .hush:has(span) { background-clip: border-box; }`,
        ),
      ).toEqual({ guarded: leftInset });
    });
  }, 30_000);
});

describe('readGroundTruth: a semi-transparent border is printed like an opaque one', () => {
  test.each([
    ['rgba()', 'rgba(0, 0, 0, 0.5)'],
    ['the slash syntax', 'color(srgb 0 0 0 / 0.5)'],
  ])(
    'a half-transparent border written with %s moves every side',
    async (_name, color) => {
      await withPage(async page => {
        expect(
          await read(page, block('half', `border: 1px solid ${color}`)),
        ).toEqual({ half: paintedBox });
      });
    },
    30_000,
  );

  test('a collapsed table whose cell borders are transparent keeps its layout box; half-transparent ones round it', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><table data-gt="table" data-gt-id="clear" class="clear">
           <tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>
         <table data-gt="table" data-gt-id="half" class="half">
           <tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table></div>`,
        `${css} table { border-collapse: collapse; table-layout: fixed; width: 100.5px; margin: 0.3125px 0 0 0.3125px; }
         td { padding: 0; height: 20.3125px; }
         .clear td { border: 1px solid transparent; }
         .half td { border: 1px solid rgba(0, 0, 0, 0.5); }`,
      );
      const clear = await tableBox(page, 'clear', false);
      const half = await tableBox(page, 'half', true);
      const result = await readGroundTruth(page, source);
      expect(
        Object.fromEntries(result.blocks.map(b => [b.id, b.bbox])),
      ).toEqual({ clear, half });
    });
  }, 30_000);
});
