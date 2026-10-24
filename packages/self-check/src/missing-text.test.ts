import { afterEach, expect, test, vi } from 'vitest';
import { type ExpectedBlock, missingText, type PdfTextItem } from './index.ts';
import * as pdfReader from './pdf.ts';

// Exact geometry belongs at the reader seam: font metrics and PDF text-run
// merging must not move an anchor across these one-point boundaries.
const item: PdfTextItem = {
  text: 'radius',
  x0: 40,
  x1: 80,
  baseline: 100,
  size: 20,
  font: 'FixtureFont',
};
const box = { x0: 60, y0: 93, x1: 100, y1: 110 };

function printed(items: PdfTextItem[]) {
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
    pages: [{ width: 595, height: 842, items }],
  });
}

afterEach(() => vi.restoreAllMocks());

test.each([
  {
    edge: 'centre at left/top despite ink outside',
    x: 60,
    y: 93,
    inside: true,
  },
  { edge: 'left tolerance', x: 59, y: 100, inside: true },
  { edge: 'right tolerance', x: 101, y: 100, inside: true },
  { edge: 'top tolerance', x: 80, y: 92, inside: true },
  { edge: 'bottom tolerance', x: 80, y: 111, inside: true },
  { edge: 'beyond left tolerance', x: 58.9, y: 100, inside: false },
  { edge: 'beyond right tolerance', x: 101.1, y: 100, inside: false },
  { edge: 'beyond top tolerance', x: 80, y: 91.9, inside: false },
  { edge: 'beyond bottom tolerance', x: 80, y: 111.1, inside: false },
])(
  'block membership uses the text anchor and 1 pt tolerance: $edge',
  async ({ x, y, inside }) => {
    printed([{ ...item, x0: x - 20, x1: x + 20, baseline: y + 7 }]);
    const expected: ExpectedBlock[][] = [[{ box, texts: ['radius'] }]];
    expect(await missingText(new Uint8Array(), expected)).toEqual(
      inside ? [] : ['page 1: radius'],
    );
  },
);

test('nested blocks independently reuse the same printed occurrence', async () => {
  printed([item]);
  const expected: ExpectedBlock[][] = [
    [
      { box: { x0: 0, y0: 0, x1: 300, y1: 300 }, texts: ['radius'] },
      { box, texts: ['radius'] },
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([]);
});
