// T07-33: renderPdf turns the self-check's "can't measure" refusal from the
// text check (`UnmeasurablePdfError`, T14-10) into 422 pdf_unmeasurable for
// every budget limit, with the self-check's reason as the only detail. A
// file the scan can't read at all (`structure`) is Chrome's own output the
// platform failed to parse, not a pack fault: it stays an error, as it does
// in `checkPdf`. A fake page stands in for the browser and the text check
// is made to refuse, so each limit is pinned without printing a huge PDF.
//
// T07-36: a pack with no data-gt text never reached the text check, so the
// same PDF printed with 200 and only the batch self-check refused it. Every
// print now runs the document budget (`countOperations`): through the text
// check when there is text (its `readPdf` scans first, so no second scan),
// directly when there is none.
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import * as selfCheck from '@pdf-generator/self-check';
import { UnmeasurablePdfError } from '@pdf-generator/self-check';
import { beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

vi.mock('@pdf-generator/self-check', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@pdf-generator/self-check')>();
  return {
    ...actual,
    missingText: vi.fn(actual.missingText),
    countOperations: vi.fn(actual.countOperations),
  };
});

const missingText = vi.mocked(selfCheck.missingText);
const countOperations = vi.mocked(selfCheck.countOperations);

beforeEach(() => {
  missingText.mockClear();
  countOperations.mockClear();
});

// Text for the check to look for: missingText runs only when there is some.
const expectedText = [
  [
    {
      texts: [
        {
          text: '前文',
          boxes: [{ x0: 0, y0: 0, x1: 100, y1: 100 }],
        },
      ],
    },
  ],
];

/** What the print runtime reports once the PDF is printed. */
type Printed = { expectedText?: typeof expectedText | [][] };

async function run(printedState: Printed = { expectedText }) {
  let printed = false;
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, pageWidth?: number) => {
      if (pageWidth !== undefined) return printed ? printedState : {};
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
  return renderPdf(
    fakeBrowserContext(page).browser,
    {
      html: '<!doctype html><html><body><p data-gt="paragraph">前文</p></body></html>',
      page: { size: 'A4', orientation: 'portrait' },
    },
    {
      assetOrigin: 'https://print-assets.example.test',
      store: { put: async () => {}, delete: async () => {} },
      inspect: async () => 'ground truth',
    },
  ).then(
    result => ({ result }),
    (error: unknown) => ({ error }),
  );
}

test.each([
  { limit: 'operations', reason: 'over 262144 operators' },
  { limit: 'nesting', reason: 'nesting past 64' },
  { limit: 'content', reason: 'decoded content over 16777216 bytes' },
] as const)(
  'the $limit limit is refused as pdf_unmeasurable',
  async ({ limit, reason }) => {
    missingText.mockRejectedValueOnce(
      new UnmeasurablePdfError({ ok: false, limit, reason }),
    );
    const outcome = await run();
    expect(missingText).toHaveBeenCalled();
    expect(outcome).toEqual({ error: expect.any(RenderError) });
    expect(outcome).toMatchObject({
      error: { code: 'pdf_unmeasurable', details: [reason] },
    });
  },
);

test('an unreadable PDF structure is not reported as a pack fault', async () => {
  const unreadable = new UnmeasurablePdfError({
    ok: false,
    limit: 'structure',
    reason: 'no page found',
  });
  missingText.mockRejectedValueOnce(unreadable);
  const outcome = await run();
  expect(outcome).toEqual({ error: unreadable });
});

// What the runtime reports for a pack without data-gt text: no expected text
// at all, or pages without blocks (print-runtime.js `expectedText`).
const textless = [
  { name: 'no expected text', printed: {} },
  { name: 'pages without text blocks', printed: { expectedText: [[]] } },
] satisfies { name: string; printed: Printed }[];

// Regression: a textless pack over the budget printed with 200 (T07-36).
test.each(
  textless.flatMap(({ name, printed }) =>
    (
      [
        { limit: 'operations', reason: 'over 262144 operators' },
        { limit: 'nesting', reason: 'nesting past 64' },
        { limit: 'content', reason: 'decoded content over 16777216 bytes' },
      ] as const
    ).map(refusal => ({ name, printed, ...refusal })),
  ),
)(
  'with $name, the $limit limit is refused as pdf_unmeasurable',
  async ({ printed, limit, reason }) => {
    countOperations.mockResolvedValueOnce({ ok: false, limit, reason });
    const outcome = await run(printed);
    expect(countOperations).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ error: expect.any(RenderError) });
    expect(outcome).toMatchObject({
      error: { code: 'pdf_unmeasurable', details: [reason] },
    });
  },
);

test.each(textless)(
  'with $name, an unreadable PDF structure is not reported as a pack fault',
  async ({ printed }) => {
    countOperations.mockResolvedValueOnce({
      ok: false,
      limit: 'structure',
      reason: 'no page found',
    });
    const outcome = await run(printed);
    expect(outcome).not.toEqual({ error: expect.any(RenderError) });
    expect(outcome).toEqual({ error: expect.any(UnmeasurablePdfError) });
    expect(outcome).toMatchObject({ error: { limit: 'structure' } });
  },
);

test.each(textless)(
  'with $name, a PDF within the budget is scanned once and printed',
  async ({ printed }) => {
    const outcome = await run(printed);
    expect(countOperations).toHaveBeenCalledTimes(1);
    const [scanned] = countOperations.mock.calls[0] ?? [];
    expect(scanned?.byteLength).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ result: { pageCount: 1 } });
    expect(missingText).not.toHaveBeenCalled();
  },
);

// The text check's readPdf already runs the budget: a print with text is
// not scanned a second time.
test('a print with text is scanned only by the text check', async () => {
  // The blank fixture lacks the text: the check finds it all here.
  missingText.mockResolvedValueOnce([]);
  const outcome = await run();
  expect(missingText).toHaveBeenCalledTimes(1);
  expect(countOperations).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ result: { pageCount: 1 } });
});
