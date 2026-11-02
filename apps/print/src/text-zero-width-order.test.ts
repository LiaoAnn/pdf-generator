// T07-30: data-gt text laid out with zero width (negative letter-spacing,
// word-spacing) can't be matched against the PDF's text layer, so the print
// runtime reports it (`zeroWidthText`) and renderPdf refuses the print with
// its own code instead of skipping the text; zero-height text (T07-31) the
// same way with text_zero_height. A fake page stands in for the
// browser: these tests pin how renderPdf treats the runtime's report.
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

const zeroWidth = ['page 1: 擠成零寬的文字', 'page 2: SQUEEZED'];
const clipped = ['page 1 div clipped 50.0px at the bottom'];
// Text the blank fixture PDF doesn't contain: text_missing if it is checked.
const missingFromPdf = [
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
];

// `after` is what the runtime's printed() returns once the PDF is printed.
async function run(after: Record<string, unknown>) {
  let printed = false;
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, pageWidth?: number) => {
      if (pageWidth !== undefined) return printed ? after : {};
      return {
        pageCount: 1,
        pageSize: { width: 793.7, height: 1122.5 },
        unloadedFaces: [],
        fragmentedRows: [],
      };
    }),
    pdf: vi.fn(async () => {
      printed = true;
      return new Uint8Array(
        readFileSync(
          new URL('./test-fixtures/blank-1-pages.pdf', import.meta.url),
        ),
      );
    }),
    close: vi.fn(async () => {}),
  };
  const inspect = vi.fn(async () => 'ground truth');
  const outcome = await renderPdf(
    fakeBrowserContext(page).browser,
    {
      html: '<!doctype html><html><body><p data-gt="paragraph">x</p></body></html>',
      page: { size: 'A4', orientation: 'portrait' },
    },
    {
      assetOrigin: 'https://print-assets.example.test',
      store: { put: async () => {}, delete: async () => {} },
      inspect,
    },
  ).then(
    result => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { outcome, page, inspect };
}

// Regression: zero-width text was dropped from the text check and the PDF
// printed, so text the PDF lacks escaped the check (T07-30).
test('zero-width data-gt text rejects with text_zero_width and keeps every detail', async () => {
  const { outcome, page, inspect } = await run({ zeroWidthText: zeroWidth });
  expect(outcome).toHaveProperty('error');
  const { error } = outcome as { error: unknown };
  expect(error).toBeInstanceOf(RenderError);
  expect(error).toMatchObject({ code: 'text_zero_width', details: zeroWidth });
  expect(inspect).not.toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledTimes(1);
});

// Regression: a check that refuses on an empty or missing list would refuse
// every print, also from a runtime that doesn't report the field.
test.each([
  { name: 'absent', state: {} },
  { name: 'empty', state: { zeroWidthText: [] } },
])(
  '$name zero-width diagnostics allow ground-truth inspection',
  async ({ state }) => {
    const { outcome, inspect } = await run(state);
    expect(outcome).toHaveProperty('result');
    expect(inspect).toHaveBeenCalledTimes(1);
  },
);

// Regression: answering text_missing ("usually a missing glyph") for text
// that is there but squeezed to zero width sends the author after the font.
test('text_zero_width precedes text_missing when both are found', async () => {
  const { outcome } = await run({
    zeroWidthText: zeroWidth,
    expectedText: missingFromPdf,
  });
  expect(outcome).toMatchObject({
    error: { code: 'text_zero_width', details: zeroWidth },
  });
});

// Regression: ancestor clipping can also narrow text; its own guidance
// (content_clipped) keeps precedence, as it does over text_missing.
test('content_clipped precedes text_zero_width', async () => {
  const { outcome } = await run({
    clippedContent: clipped,
    zeroWidthText: zeroWidth,
  });
  expect(outcome).toMatchObject({
    error: { code: 'content_clipped', details: clipped },
  });
});

// T07-31: data-gt text laid out with zero height (font-size 0, scaleY(0),
// scale(0)) was skipped by the text check while gt.json still records its
// text. The runtime reports it (`zeroHeightText`) and renderPdf refuses the
// print with text_zero_height, whose guidance (remove the zero font size or
// the flattening transform) differs from text_zero_width's.
const zeroHeight = ['page 1: 零號字', 'page 3: FLATTENED'];

// Regression: zero-height text was dropped from the text check and the PDF
// printed with ground truth it can't back up (T07-31).
test('zero-height data-gt text rejects with text_zero_height and keeps every detail', async () => {
  const { outcome, page, inspect } = await run({ zeroHeightText: zeroHeight });
  expect(outcome).toHaveProperty('error');
  const { error } = outcome as { error: unknown };
  expect(error).toBeInstanceOf(RenderError);
  expect(error).toMatchObject({
    code: 'text_zero_height',
    details: zeroHeight,
  });
  expect(inspect).not.toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledTimes(1);
});

// Regression: refusing on an empty list would refuse every print.
test('empty zero-height diagnostics allow ground-truth inspection', async () => {
  const { outcome, inspect } = await run({ zeroHeightText: [] });
  expect(outcome).toHaveProperty('result');
  expect(inspect).toHaveBeenCalledTimes(1);
});

// Regression: text_missing's font advice would send the author after the
// wrong cause for text that is there but flattened to zero height.
test('text_zero_height precedes text_missing when both are found', async () => {
  const { outcome } = await run({
    zeroHeightText: zeroHeight,
    expectedText: missingFromPdf,
  });
  expect(outcome).toMatchObject({
    error: { code: 'text_zero_height', details: zeroHeight },
  });
});

// The earlier refusals keep their place: clipping first, then zero width.
test.each([
  {
    name: 'content_clipped',
    state: { clippedContent: clipped },
    error: { code: 'content_clipped', details: clipped },
  },
  {
    name: 'text_zero_width',
    state: { zeroWidthText: zeroWidth },
    error: { code: 'text_zero_width', details: zeroWidth },
  },
])('$name precedes text_zero_height', async ({ state, error }) => {
  const { outcome } = await run({ ...state, zeroHeightText: zeroHeight });
  expect(outcome).toMatchObject({ error });
});
