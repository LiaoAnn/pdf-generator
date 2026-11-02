// T08-4 slice 4: text-decoration (underline, overline, line-through) is
// drawn with the glyphs, at a place the font's metrics decide, which the DOM
// doesn't expose; like a glyph's descender or overhang it is the text's own
// ink, so the gt box stays the block's box. The self-check judges text by
// its glyph bodies, so a decoration outside the box is allowed by it.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'text-decoration',
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

function boxes(result: GroundTruth): Record<string, number[]> {
  return Object.fromEntries(result.blocks.map(b => [b.id, b.bbox]));
}

describe('readGroundTruth: text-decoration is the text’s own ink, not in the box', () => {
  test.each([
    [
      'an underline pushed below the line box',
      'underline 3px; text-underline-offset: 6px',
    ],
    ['an overline above a tight line box', 'overline 2px'],
    ['a line-through', 'line-through 2px'],
  ])(
    '%s leaves the box where the undecorated block’s is, on pages 2 and 3',
    async (_, decoration) => {
      await withPage(async page => {
        // The same heading at the same place on three pages: plain on page
        // 1, decorated on pages 2 and 3. With line-height 1 Chrome draws the
        // overline above the line box and the offset underline below it
        // (probed: 2.69 px and 6.31 px outside), where the font's metrics say.
        const heading = (id: string, style: string, next: boolean) =>
          `<div class="pad${next ? ' next' : ''}"><h1 data-gt="heading" data-gt-id="${id}" style="font: 20px/1 sans-serif; ${style}">Tg</h1></div>`;
        const decorated = `text-decoration: ${decoration}`;
        await paginate(
          page,
          `${heading('plain', '', false)}${heading('decorated', decorated, true)}${heading('decorated3', decorated, true)}`,
          css,
        );
        const result = await readGroundTruth(page, source);
        const box = boxes(result);
        expect(result.blocks.map(b => b.page)).toEqual([1, 2, 3]);
        expect(box.decorated).toEqual(box.plain);
        expect(box.decorated3).toEqual(box.plain);
        expect(gtSchema.parse(result)).toEqual(result);
      });
    },
    30_000,
  );
});
