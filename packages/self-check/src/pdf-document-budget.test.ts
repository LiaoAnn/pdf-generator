import { gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import * as unpdf from 'unpdf';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  checkPdf,
  type ExpectedBlock,
  missingText,
  readPdf,
  UnmeasurablePdfError,
} from './index.ts';
import { maxNesting, maxOperations } from './operations.ts';

// One budget for the whole document, counted before pdf.js reads it (T14-10):
// T14-9's repros spent 46 s inside pdf.js (480 nested opacity groups) or ran
// a 128 MB Worker out of memory (300,000 rects) before any per-structure cap
// applied.

vi.mock('unpdf', async importOriginal => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return { ...actual, getDocumentProxy: vi.fn(actual.getDocumentProxy) };
});

const opened = vi.mocked(unpdf.getDocumentProxy);

let browser: Awaited<ReturnType<typeof chromium.launch>>;
let overOperations: Uint8Array;
let overNesting: Uint8Array;
let underOperations: Uint8Array;

// Each rect is at least its `re` and its fill: at least two operators.
const overRects = Math.floor(maxOperations / 2) + 1;
// Chromium spends at most a handful of operators on a rect.
const underRects = Math.floor(maxOperations / 8);

async function print(svg: string, text = '') {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>@page{size:A4;margin:0}body{margin:0}</style>
      <p style="margin:0;font:12pt sans-serif">${text}</p>
      <svg width="100pt" height="100pt" viewBox="0 0 100 100">${svg}</svg>`);
    return new Uint8Array(await page.pdf({ preferCSSPageSize: true }));
  } finally {
    await page.close();
  }
}

// Alternating almost-black fills keep Chromium from merging the paths.
const rects = (count: number) =>
  '<rect width="50" height="50" fill="#000000"/><rect width="50" height="50" fill="#000001"/>'.repeat(
    Math.floor(count / 2),
  ) + (count % 2 ? '<rect width="50" height="50"/>' : '');

const nestedGroups = (depth: number) =>
  `${Array.from({ length: depth }, (_, i) => `<g opacity="0.999"><rect width="50" height="50" fill="${i % 2 ? '#000001' : '#000000'}"/>`).join('')}${'</g>'.repeat(depth)}`;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  overOperations = await print(rects(overRects), 'BUDGET');
  overNesting = await print(nestedGroups(maxNesting + 16).repeat(2), 'BUDGET');
  underOperations = await print(rects(underRects));
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

test.each([
  [
    'more operators than the document budget',
    () => overOperations,
    'operations',
  ],
  ['groups nested past the nesting cap', () => overNesting, 'nesting'],
] as const)(
  'readPdf refuses %s before pdf.js opens the document',
  async (_, pdf, limit) => {
    opened.mockClear();
    const error = await readPdf(pdf()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnmeasurablePdfError);
    expect((error as UnmeasurablePdfError).limit).toBe(limit);
    expect(opened).not.toHaveBeenCalled();
  },
);

test('a document just under the budget is still read whole: every rect is a mark', async () => {
  const document = await readPdf(underOperations);
  expect(document.pages).toHaveLength(1);
  expect(document.pages[0]?.marks.length).toBeGreaterThanOrEqual(underRects);
});

test('checkPdf reports a document over the budget as one difference saying it can’t be measured, not as passing', async () => {
  const gt = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'document-budget',
      templateVersion: 1,
      seed: 'T14-10',
      index: 0,
    },
    pages: [{ width: 595.28, height: 841.89 }],
    blocks: [],
  });
  for (const [pdf, limit] of [
    [overOperations, 'operations'],
    [overNesting, 'nesting'],
  ] as const) {
    const report = await checkPdf(pdf, gt);
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({
        kind: 'unmeasurable',
        limit,
        message: expect.stringContaining("can't measure"),
      }),
    ]);
  }
});

test('missingText refuses a document over the budget with the same typed error, so the print Worker never treats it as checked', async () => {
  const expected: ExpectedBlock[][] = [
    [
      {
        texts: [
          { text: 'BUDGET', boxes: [{ x0: 0, y0: 0, x1: 595, y1: 842 }] },
        ],
      },
    ],
  ];
  await expect(missingText(overOperations, expected)).rejects.toBeInstanceOf(
    UnmeasurablePdfError,
  );
});

test('checkPdf still throws on a file the scan can’t read at all, so a batch fails that job rather than completing it with a report', async () => {
  const gt = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'document-budget',
      templateVersion: 1,
      seed: 'T14-10',
      index: 0,
    },
    pages: [{ width: 595.28, height: 841.89 }],
    blocks: [],
  });
  const error = await checkPdf(new Uint8Array([1, 2, 3, 4]), gt).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UnmeasurablePdfError);
  expect((error as UnmeasurablePdfError).limit).toBe('structure');
  // The batch stores the message; it says so in pdf.js's words, as before.
  expect((error as UnmeasurablePdfError).message).toMatch(/^Invalid PDF/);
});
