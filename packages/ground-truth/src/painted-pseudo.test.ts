// T08-4 slice 3: a ::before or ::after box belongs to the element it is
// generated on, so what it paints counts for the block holding that element
// as an element's own would: its background or borders (painted on rounded
// edges like a background, T08-3) move a side they share inside the box and
// grow the box where they lie outside it; its outline and shadow grow the
// box (slices 1 and 2). It shows only inside the overflow clips around it
// (the host's own overflow clips it too). Reading leaves the page as it was.
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'painted-pseudo',
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
  .small { position: relative; width: 40.5px; height: 30.5px; }
  .next { break-before: page; }
  /* A bullet 12.25 px left of its item: 62..68.25 x 105..111.25 px. */
  .bullet::before { content: ''; position: absolute; left: -12.25px; top: 4.25px;
    width: 6.25px; height: 6.25px; border-radius: 50%; background: #000; }`;

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

describe('readGroundTruth: ::before and ::after paint for their block', () => {
  test('a bullet outside its item grows the item’s box to the bullet’s rounded edge, on page 2 as on page 1', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="item" class="small bullet"></div></div>
         <div class="pad next"><div data-gt="list_item" data-gt-id="item2" class="small bullet"></div></div>`,
      );
      // The bullet's left edge, 62 px, is the box's left; nothing else moves.
      expect(result.blocks.map(b => b.page)).toEqual([1, 2]);
      expect(boxes(result)).toEqual({
        item: [46.5, 75.56, 86.06, 98.44],
        item2: [46.5, 75.56, 86.06, 98.44],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('an ::after that paints only a border strip outside the box grows it to that strip', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="ruled" class="small rule"></div></div>`,
        // A 2 px rule 8.25 px right of the box: 121..123 px.
        `.rule::after { content: ''; position: absolute; right: -8.25px; top: 0; bottom: 0;
           border-right: 2px solid #000; }`,
      );
      expect(boxes(result)).toEqual({ ruled: [55.69, 75.56, 92.25, 98.44] });
    });
  }, 30_000);

  test('a bullet inside the box touching no side moves no side', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="inner" class="small dot"></div></div>`,
        `.dot::before { content: ''; position: absolute; left: 1.25px; top: 5.25px;
           width: 6.25px; height: 6.25px; background: #000; }`,
      );
      expect(boxes(result)).toEqual({ inner: layoutBox });
    });
  }, 30_000);

  test('a bar along the box’s left side moves the sides it shares to its painted edges, as a background inside the box does', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="barred" class="small bar"></div></div>`,
        // 74.25..77.5 x 100.75..131.25 px: shares the left, top and bottom.
        `.bar::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0;
           width: 3.25px; background: #000; }`,
      );
      expect(boxes(result)).toEqual({ barred: [55.5, 75.75, 86.06, 98.25] });
    });
  }, 30_000);

  test('an in-flow ::before with text is measured where it is laid out, and its text stays out of the block’s text', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="noted" class="small note"></div></div>`,
        // A block-level label across the top: 74.25..114.75 x 100.75..111 px.
        `.note::before { content: "Note \\"1\\""; display: block; height: 10.25px;
           background: #000; color: #fff; }`,
      );
      expect(boxes(result)).toEqual({ noted: [55.5, 75.75, 86.25, 98.44] });
      expect(result.blocks[0]?.text).toBe('');
    });
  }, 30_000);

  test('a ::before of an element inside the block counts too', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="tagged" class="small"><span class="tag">x</span></div></div>`,
        // 20.25 px left of the span, which starts at the block's left: 54 px.
        `.tag { position: relative; }
         .tag::before { content: ''; position: absolute; left: -20.25px; top: 2.25px;
           width: 4.25px; height: 4.25px; background: #000; }`,
      );
      expect(boxes(result)).toEqual({ tagged: [40.5, 75.56, 86.06, 98.44] });
    });
  }, 30_000);

  test('the outline of an ::after outside the box grows it, as an element’s own outline does', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="flagged" class="small flag"></div></div>`,
        // 118.75..121 x 100.75..111 px, rounded 119..121 x 101..111, outlined
        // 1 px: 118..122 x 100..112.
        `.flag::after { content: ''; position: absolute; right: -6.25px; top: 0;
           width: 2.25px; height: 10.25px; outline: 1px solid #000; }`,
      );
      expect(boxes(result)).toEqual({ flagged: [55.69, 75, 91.5, 98.44] });
    });
  }, 30_000);

  test.each([
    ['content none', 'content: none'],
    ['display none', 'display: none'],
    ['a transparent background', 'background: transparent'],
    ['visibility hidden', 'visibility: hidden'],
  ])(
    'a pseudo-element that paints nothing (%s) moves no side',
    async (_, style) => {
      await withPage(async page => {
        const result = await read(
          page,
          `<div class="pad"><div data-gt="list_item" data-gt-id="quiet" class="small bullet quiet"></div></div>`,
          `.quiet.bullet::before { ${style}; }`,
        );
        expect(boxes(result)).toEqual({ quiet: layoutBox });
      });
    },
    30_000,
  );

  test('a bullet hidden by its own item’s overflow clip moves no side', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="clipped" class="small bullet" style="overflow: hidden"></div></div>`,
      );
      expect(boxes(result)).toEqual({ clipped: layoutBox });
    });
  }, 30_000);

  test('reading leaves the page exactly as it was and reads the same twice', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="item" class="small bullet">One</div>
         <div data-gt="paragraph" data-gt-id="noted" class="small note">Two</div></div>`,
        `${css} .note::before { content: "Note"; display: block; background: #000; }`,
      );
      const snapshot = `(() => [document.documentElement.outerHTML,
        Array.from(document.querySelectorAll('*'), e => JSON.stringify(e.getBoundingClientRect())).join()])()`;
      const before = await page.evaluate(snapshot);
      const first = await readGroundTruth(page, source);
      const after = await page.evaluate(snapshot);
      expect(after).toEqual(before);
      expect(await readGroundTruth(page, source)).toEqual(first);
      expect(first.blocks.map(b => b.text)).toEqual(['One', 'Two']);
    });
  }, 30_000);

  test('the shadow of a ::before outside the box grows it, as an element’s own shadow does', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="shaded" class="small shade"></div></div>`,
        // A transparent 4.25 px square 10.25 px left of the box (64..68.25 x
        // 104.75..109 px, rounded 64..68 x 105..109) whose 2 px spread shadow
        // reaches 62..70 x 103..111.
        `.shade::before { content: ''; position: absolute; left: -10.25px; top: 4px;
           width: 4.25px; height: 4.25px; box-shadow: 0 0 0 2px #000; }`,
      );
      expect(boxes(result)).toEqual({ shaded: [46.5, 75.56, 86.06, 98.44] });
    });
  }, 30_000);

  test('a pack attribute the reader also uses is left with its own value, and the box read with it', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="owned" class="small bullet" data-collect-pseudo-host="custom"></div>
         <div data-gt="paragraph" data-gt-id="plain" class="small" data-collect-pseudo-host="custom"></div></div>`,
        // Without the attribute the blocks would be 80.5 px wide and black.
        `${css} [data-gt]:not([data-collect-pseudo-host="custom"]) { width: 80.5px; background: #000; }`,
      );
      const html = `document.documentElement.outerHTML`;
      const before = await page.evaluate(html);
      const first = await readGroundTruth(page, source);
      expect(await page.evaluate(html)).toEqual(before);
      expect(await readGroundTruth(page, source)).toEqual(first);
      // The bullet grows the first box; the second keeps its layout box,
      // 30.5 px lower.
      expect(boxes(first)).toEqual({
        owned: [46.5, 75.56, 86.06, 98.44],
        plain: [55.69, 98.44, 86.06, 121.31],
      });
    });
  }, 30_000);

  test('a rebuild that changes what an element paints, not where it is, measures no pseudo-element', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="tinted" class="small bullet tint"></div></div>`,
        // A child in the item would paint it black; the printed page has none.
        `.tint:has(*) { background: #000; box-shadow: 30px 0 0 #000; }`,
      );
      expect(boxes(result)).toEqual({ tinted: layoutBox });
    });
  }, 30_000);

  test('a rebuild that changes an ancestor’s clip, not the block, measures no pseudo-element', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div class="wrap"><div data-gt="list_item" data-gt-id="framed" class="small bullet"></div></div></div>`,
        // The wrapper clips the bullet on the printed page; a child anywhere
        // in it would stop that.
        `.wrap { overflow: hidden; } .wrap:has(span) { overflow: visible; }`,
      );
      expect(boxes(result)).toEqual({ framed: layoutBox });
    });
  }, 30_000);

  test('a page with no pseudo-element to rebuild is read without inserting anything', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div class="pad"><div data-gt="paragraph" data-gt-id="plain" class="small"></div></div>`,
        css,
      );
      // A rule that holds only while the head has one more <style> than it
      // has now (this rule's own included) would give the block a shadow.
      await page.evaluate(`(() => {
        const count = document.head.querySelectorAll('style').length;
        const rule = document.createElement('style');
        rule.textContent = 'html:has(head > style:nth-of-type(' + (count + 2) + ')) [data-gt] { box-shadow: 100px 0 0 #000; }';
        document.head.appendChild(rule);
      })()`);
      const result = await readGroundTruth(page, source);
      expect(boxes(result)).toEqual({ plain: layoutBox });
    });
  }, 30_000);

  test('a pseudo-element whose rebuilding would change the layout is left out', async () => {
    await withPage(async page => {
      const result = await read(
        page,
        `<div class="pad"><div data-gt="list_item" data-gt-id="guarded" class="small bullet guard"></div></div>`,
        // Any child element in the item would widen it.
        `.guard:has(*) { width: 80.5px; }`,
      );
      expect(boxes(result)).toEqual({ guarded: layoutBox });
    });
  }, 30_000);
});
