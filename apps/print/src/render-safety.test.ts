import type { Browser } from '@cloudflare/puppeteer';
import { expect, test, vi } from 'vitest';
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
    name: 'fragmented rows prevent inspection and PDF output',
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
    goto: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      pageCount: 4,
      unloadedFaces: fixture.unloadedFaces,
      fragmentedRows: fixture.fragmentedRows,
    })),
    pdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    close: vi.fn(async () => {}),
  };
  const browser = { newPage: vi.fn(async () => page) };
  const inspect = vi.fn(async () => 'ground truth');
  const outcome = await renderPdf(browser as unknown as Browser, request, {
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
  expect.soft(inspect).not.toHaveBeenCalled();
  expect.soft(page.pdf).not.toHaveBeenCalled();
  expect(page.evaluate).toHaveBeenCalledTimes(1);
  expect(page.close).toHaveBeenCalledTimes(1);
});
