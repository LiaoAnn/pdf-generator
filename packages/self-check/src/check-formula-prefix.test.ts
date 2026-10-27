import { fileURLToPath } from 'node:url';
import { gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  checkPdf,
  type Difference,
  type PdfPage,
  type PdfTextItem,
  readPdf,
} from './index.ts';
import * as pdfReader from './pdf.ts';

let mathPdf: Uint8Array;

function groundTruth(text: string, type: 'formula' | 'paragraph' = 'formula') {
  return gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'math-prefix',
      templateVersion: 1,
      seed: 'T14-1',
      index: 0,
    },
    pages: [{ width: 595.28, height: 841.89 }],
    blocks: [
      {
        id: 'math',
        type,
        page: 1,
        bbox: [54, 54, 414, 90],
        order: 0,
        text,
        ...(type === 'formula' ? { latex: 'fixture' } : {}),
      },
    ],
  });
}

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(
      new URL('../fixtures/math-prefix.html', import.meta.url).href,
    );
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(`window.__pagedDone = false; window.PagedConfig = {
      auto: true, after: () => { window.__pagedDone = true; }
    };`);
    await page.addScriptTag({
      path: fileURLToPath(
        new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
      ),
    });
    await page.waitForFunction('window.__pagedDone === true');
    await page.evaluate('document.fonts.ready');
    mathPdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
    const { pages } = await readPdf(mathPdf);
    // Prove that Chrome painted both copies before testing the suffix rule.
    expect(pages).toHaveLength(1);
    expect(pages[0]?.items.map(item => item.text).join('')).toBe('𝑥+𝑦x + y');
  } finally {
    await browser.close();
  }
});

afterEach(() => vi.restoreAllMocks());

function mockPrinted(text: string) {
  // Keep both copies in a single item: finding the visible copy as a separate
  // run would exercise relocation rather than formula-prefix validation.
  const item: PdfTextItem = {
    text,
    x0: 60,
    x1: 160,
    baseline: 72,
    size: 12,
    font: 'FixtureFont',
  };
  const page: PdfPage = {
    width: 595.28,
    height: 841.89,
    items: [item],
    marks: [],
    paints: [],
  };
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({ pages: [page] });
}

function textDifference(expected: string, actual: string): Difference {
  return {
    kind: 'text',
    page: 1,
    blockId: 'math',
    expected,
    actual,
    message: expect.any(String),
  };
}

test('the real painted MathML copy still accepts the complete formula after normalization', async () => {
  expect(await checkPdf(mathPdf, groundTruth('x + y'))).toEqual({
    ok: true,
    differences: [],
  });
});

test.each(['y', '+y'])(
  'a truncated ground truth %s cannot pass as a suffix of the real formula',
  async text => {
    expect(await checkPdf(mathPdf, groundTruth(text))).toEqual({
      ok: false,
      differences: [textDifference(text, '𝑥+𝑦x + y')],
    });
  },
);

test('a reordered MathML character copy does not reject a correct fraction', async () => {
  mockPrinted('1nn1');
  expect(await checkPdf(new Uint8Array(), groundTruth('n1'))).toEqual({
    ok: true,
    differences: [],
  });
});

test.each([
  { name: 'FUNCTION APPLICATION U+2061', operator: '\u2061' },
  { name: 'INVISIBLE TIMES U+2062', operator: '\u2062' },
  { name: 'INVISIBLE SEPARATOR U+2063', operator: '\u2063' },
  { name: 'INVISIBLE PLUS U+2064', operator: '\u2064' },
])(
  'MathML $name does not invalidate the formula copy',
  async ({ operator }) => {
    mockPrinted(`log${operator}xlogx`);
    expect(await checkPdf(new Uint8Array(), groundTruth('logx'))).toEqual({
      ok: true,
      differences: [],
    });
  },
);

test('a same-length prefix with a substituted character is not a MathML copy', async () => {
  mockPrinted('x+zx+y');
  expect(await checkPdf(new Uint8Array(), groundTruth('x+y'))).toEqual({
    ok: false,
    differences: [textDifference('x+y', 'x+zx+y')],
  });
});

test('a MathML prefix with an extra repeated character is not a formula copy', async () => {
  mockPrinted('xx+yx+y');
  expect(await checkPdf(new Uint8Array(), groundTruth('x+y'))).toEqual({
    ok: false,
    differences: [textDifference('x+y', 'xx+yx+y')],
  });
});

test('a paragraph cannot discard a matching character-copy prefix', async () => {
  mockPrinted('x+yx+y');
  expect(
    await checkPdf(new Uint8Array(), groundTruth('x+y', 'paragraph')),
  ).toEqual({
    ok: false,
    differences: [textDifference('x+y', 'x+yx+y')],
  });
});
