import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { normaliseText, type PdfDocument, readPdf } from './index.ts';

interface LayoutItem {
  text: string;
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

let pdf: Buffer;
let layout: LayoutItem[];
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(new URL('../fixtures/reader.html', import.meta.url).href);
    await page.emulateMedia({ media: 'print' });
    // Independent oracle: CSS geometry and a zero-height inline baseline marker,
    // measured before printing. Do not derive expectations with a PDF parser.
    layout = await page.evaluate(`(async () => {
      await document.fonts.ready;
      if (!document.fonts.check('32px FixtureSymbols', '☀☁★')) {
        throw new Error('fixture font did not load');
      }
      return ['#first > span', '#second > span', '#symbols > span',
        '#last > span', '#gap-left', '#gap-right'].map(selector => {
        const span = document.querySelector(selector);
        const element = span.closest('p');
        const box = span.getBoundingClientRect();
        const baseline = element.querySelector('.baseline').getBoundingClientRect();
        const section = element.closest('section').getBoundingClientRect();
        return {
          text: span.textContent,
          x0: box.left * 0.75,
          x1: box.right * 0.75,
          baseline: (baseline.top - section.top) * 0.75,
          size: parseFloat(getComputedStyle(span).fontSize) * 0.75,
        };
      });
    })()`);
    pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(layout.map(item => item.text)).toEqual([
      'STREAM-FIRST',
      'STREAM-SECOND',
      '☀☁★',
      'PAGE-TWO',
      'LEFT',
      'RIGHT',
    ]);
  } finally {
    await browser.close();
  }
});

afterAll(async () => {
  await worker?.dispose();
});

function expectPrintedLayout(document: PdfDocument) {
  expect(document.pages).toHaveLength(2);
  for (const [pageIndex, page] of document.pages.entries()) {
    // Chrome's actual MediaBox, not the nominal A4 dimensions from CSS.
    expect(Math.abs(page.width - 594.96)).toBeLessThan(0.03);
    expect(Math.abs(page.height - 841.92)).toBeLessThan(0.03);
    const expected = pageIndex === 0 ? layout.slice(0, 3) : layout.slice(3);
    expect(page.items.map(item => item.text)).toEqual(
      expected.map(item => item.text),
    );
    for (const [index, item] of page.items.entries()) {
      const oracle = expected[index];
      expect(oracle).toBeDefined();
      if (!oracle) throw new Error('missing layout oracle');
      // Subpixel font metrics / Chrome's print scaling can differ slightly.
      for (const key of ['x0', 'x1', 'baseline', 'size'] as const) {
        expect(
          Math.abs(item[key] - oracle[key]),
          `${item.text}: ${key}`,
        ).toBeLessThan(0.5);
      }
      if (item.text === '☀☁★') {
        expect(item.font).toBe('NotoSansSymbols2-Regular');
      }
    }
  }
}

test('workerd reads Chromium MediaBoxes, CSS text geometry, embedded font names and content-stream order', async () => {
  worker = await unstable_startWorker({
    entrypoint: fileURLToPath(import.meta.resolve('./test-worker.ts')),
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
    },
  });
  await worker.url;
  const response = await worker.fetch('http://fixture.test/read', {
    method: 'POST',
    body: new Uint8Array(pdf),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expectPrintedLayout(result as PdfDocument);
});

test('Node reads Chromium MediaBoxes, CSS text geometry, embedded font names and content-stream order', async () => {
  expectPrintedLayout(await readPdf(pdf));
});

test.each(['Uint8Array', 'Buffer'] as const)(
  'reading a %s view twice preserves caller bytes and respects its offset',
  async kind => {
    const backing = new Uint8Array(pdf.length + 32).fill(0xa5);
    backing.set(pdf, 16);
    const input =
      kind === 'Buffer'
        ? Buffer.from(backing.buffer, 16, pdf.length)
        : backing.subarray(16, 16 + pdf.length);
    const original = backing.slice();
    const first = await readPdf(input);
    expect(backing).toEqual(original);
    expect(input.byteLength).toBe(pdf.length);
    const second = await readPdf(input);
    expect(second).toEqual(first);
    expect(backing).toEqual(original);
    expectPrintedLayout(second);
  },
);

test('normaliseText folds compatibility glyphs, whitespace, KaTeX zero-width struts and case for comparison', () => {
  expect(
    normaliseText(' Ａ\tＢ\nＣ\r\n\u00a0\u3000K ﬁ Mi\u200bXeD \u200b'),
  ).toBe('abckfimixed');
});
