import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { type PrintedState, RenderError, renderPdf } from './lib.ts';

const request = {
  html: '<!doctype html><html><body><p data-gt="text">一月</p></body></html>',
  page: { size: 'A4', orientation: 'portrait' },
} as const;
const assetOrigin = 'https://print-assets.example.test';

// `before` is what the print-media layout reads until the PDF is printed,
// `after` what it reads once it is: a tab whose resources were still loading
// while the PDF was printed reads differently.
function fakeBrowser(before: PrintedState, after: PrintedState = before) {
  let printedPdf = false;
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, pageWidth?: number) => {
      if (pageWidth !== undefined) return printedPdf ? after : before;
      return {
        pageCount: 1,
        pageSize: { width: 793.7, height: 1122.5 },
        unloadedFaces: [],
        fragmentedRows: [],
      };
    }),
    pdf: vi.fn(async () => {
      printedPdf = true;
      return new Uint8Array(
        readFileSync(
          new URL('./test-fixtures/blank-1-pages.pdf', import.meta.url),
        ),
      );
    }),
    close: vi.fn(async () => {}),
  };
  return { browser: fakeBrowserContext(page).browser, page };
}

async function run(fake: ReturnType<typeof fakeBrowser>) {
  const inspect = vi.fn(async () => 'ground truth');
  const outcome = await renderPdf(fake.browser, request, {
    store: { put: async () => {}, delete: async () => {} },
    assetOrigin,
    inspect,
  }).then(
    result => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { ...outcome, inspect };
}

const settled = ['1 72,72,300,96', '1 72,100,300,124'];

// A short print-only animation can finish during page.pdf(), leaving identical
// block boxes and no animation in the post-PDF read despite changing the ink.
test('an animation present only before the PDF fails with css_animation before printing', async () => {
  const fake = fakeBrowser(
    { boxes: settled, animations: ['<div>: animation move'] },
    { boxes: [...settled] },
  );
  const outcome = await run(fake);
  const { error } = outcome as { error: unknown };
  expect.soft(error).toBeInstanceOf(RenderError);
  expect.soft(error).toMatchObject({
    code: 'css_animation',
    details: ['<div>: animation move'],
  });
  expect.soft(fake.page.pdf).not.toHaveBeenCalled();
  expect.soft(outcome.inspect).not.toHaveBeenCalled();
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

// Regression: ground truth is measured in print media after the PDF is
// printed; without comparing it with the layout from before, a resource that
// arrived while printing moves boxes (an image 62 pt tall) and gt.json no
// longer describes the PDF, with a 200 (T07-20 review round 3).
test.each([
  {
    name: 'a box moved',
    after: ['1 72,72,300,96', '1 72,162,300,186'],
    mentions: '72,162,300,186',
  },
  {
    name: 'a box changed page',
    after: ['1 72,72,300,96', '2 72,100,300,124'],
    mentions: '2 72,100,300,124',
  },
  {
    name: 'a box appeared',
    after: [...settled, '1 72,130,300,154'],
    mentions: '72,130,300,154',
  },
  { name: 'a box vanished', after: settled.slice(0, 1), mentions: '' },
])(
  'boxes that differ from before the PDF was printed ($name) fail with layout_unsettled and no ground truth',
  async ({ after, mentions }) => {
    const fake = fakeBrowser({ boxes: settled }, { boxes: after });
    const outcome = await run(fake);
    expect(outcome).toHaveProperty('error');
    const { error } = outcome as { error: unknown };
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({ code: 'layout_unsettled' });
    const details = (error as RenderError).details;
    expect(details.length).toBeGreaterThan(0);
    expect(details.join('\n')).toContain(mentions);
    expect(outcome.inspect).not.toHaveBeenCalled();
    expect(fake.page.pdf).toHaveBeenCalledTimes(1);
    expect(fake.page.close).toHaveBeenCalledTimes(1);
  },
);

// Regression: a check that refuses every document with boxes (or whose
// comparison is by identity of the array) would turn all prints into 422s.
test('equal boxes before and after the PDF pass, even as separate arrays', async () => {
  const fake = fakeBrowser({ boxes: [...settled] }, { boxes: [...settled] });
  const outcome = await run(fake);
  expect(outcome).toHaveProperty('result');
  expect(outcome.inspect).toHaveBeenCalledTimes(1);
});

test('a runtime that reports no boxes at all does not trigger layout_unsettled', async () => {
  const outcome = await run(fakeBrowser({}));
  expect(outcome).toHaveProperty('result');
});

// Regression: a font face that only a print-only stylesheet declares is not
// in the faces listed on screen; its failure showed up as text_missing (the
// fallback glyphs aren't the expected text) instead of its real cause.
test('a face that did not load in print media fails with font_not_loaded, ahead of text_missing', async () => {
  const printed: PrintedState = {
    unloadedFaces: ['Print Only TC 400: error'],
    boxes: settled,
    expectedText: [
      [
        {
          texts: [
            {
              text: 'MISSING FROM BLANK PDF',
              boxes: [{ x0: 0, y0: 0, x1: 100, y1: 100 }],
            },
          ],
        },
      ],
    ],
  };
  const fake = fakeBrowser(printed);
  const outcome = await run(fake);
  const { error } = outcome as { error: unknown };
  expect(error).toBeInstanceOf(RenderError);
  expect(error).toMatchObject({
    code: 'font_not_loaded',
    details: ['Print Only TC 400: error'],
  });
  expect(outcome.inspect).not.toHaveBeenCalled();
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});
