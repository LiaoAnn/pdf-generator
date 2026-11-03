// T07-33: renderPdf turns the self-check's "can't measure" refusal from the
// text check (`UnmeasurablePdfError`, T14-10) into 422 pdf_unmeasurable for
// every budget limit, with the self-check's reason as the only detail. A
// file the scan can't read at all (`structure`) is Chrome's own output the
// platform failed to parse, not a pack fault: it stays an error, as it does
// in `checkPdf`. A fake page stands in for the browser and the text check
// is made to refuse, so each limit is pinned without printing a huge PDF.
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import * as selfCheck from '@pdf-generator/self-check';
import { UnmeasurablePdfError } from '@pdf-generator/self-check';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

vi.mock('@pdf-generator/self-check', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@pdf-generator/self-check')>();
  return { ...actual, missingText: vi.fn(actual.missingText) };
});

const missingText = vi.mocked(selfCheck.missingText);

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

async function run() {
  let printed = false;
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, pageWidth?: number) => {
      if (pageWidth !== undefined) return printed ? { expectedText } : {};
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
