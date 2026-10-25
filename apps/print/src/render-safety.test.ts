import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

const request = {
  html: '<!doctype html><html><body>月報</body></html>',
  page: { size: 'A4', orientation: 'portrait' },
} as const;

test.each([
  {
    name: 'unloaded faces prevent inspection and PDF output',
    unloadedFaces: ['Broken TC 400: error', 'Unused TC 700: unloaded'],
    fragmentedRows: [],
    code: 'font_not_loaded',
    details: ['Broken TC 400: error', 'Unused TC 700: unloaded'],
  },
  {
    name: 'fragmented rows prevent successful render output',
    unloadedFaces: [],
    fragmentedRows: ['page 2: 023 新北板橋3號店', 'page 3: 045 新竹竹北5號店'],
    code: 'row_fragmented',
    details: ['page 2: 023 新北板橋3號店', 'page 3: 045 新竹竹北5號店'],
  },
  {
    name: 'font failure takes precedence over row fragmentation',
    unloadedFaces: ['Still Loading TC 400: loading'],
    fragmentedRows: ['page 2: 023 新北板橋3號店'],
    code: 'font_not_loaded',
    details: ['Still Loading TC 400: loading'],
  },
])('$name', async fixture => {
  // Regression: forwarding a bad ready state to inspect/pdf can create ground
  // truth for fallback glyphs or for rows that disappear from the PDF.
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      pageCount: 3,
      unloadedFaces: fixture.unloadedFaces,
      fragmentedRows: fixture.fragmentedRows,
    })),
    pdf: vi.fn(
      async () =>
        new Uint8Array(
          readFileSync(
            new URL('./test-fixtures/blank-3-pages.pdf', import.meta.url),
          ),
        ),
    ),
    close: vi.fn(async () => {}),
  };
  const browser = fakeBrowserContext(page).browser;
  const inspect = vi.fn(async () => 'ground truth');
  const outcome = await renderPdf(browser, request, {
    store: { put: async () => {}, delete: async () => {} },
    assetOrigin: 'https://print-assets.example.test',
    inspect,
  }).then(
    result => result,
    (error: unknown) => error,
  );

  expect.soft(outcome).toBeInstanceOf(RenderError);
  expect
    .soft(outcome)
    .toMatchObject({ code: fixture.code, details: fixture.details });
  // A print-layout probe may print/evaluate before it can judge rows.
  // Rejection and cleanup are the observable safety requirements.
  expect(page.evaluate).toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledTimes(1);
});
