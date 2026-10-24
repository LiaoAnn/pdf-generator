import { afterEach, expect, test, vi } from 'vitest';
import { type ExpectedBlock, missingText, type PdfTextItem } from './index.ts';
import * as pdfReader from './pdf.ts';

// Exact geometry belongs at the reader seam: font metrics and PDF text-run
// merging must not move overlap or vertical anchors across these boundaries.
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
    edge: 'left overlap just over 1 pt despite centre outside',
    x0: 20,
    x1: 61.1,
    y: 93,
    inside: true,
  },
  {
    edge: 'right overlap just over 1 pt despite centre outside',
    x0: 98.9,
    x1: 140,
    y: 100,
    inside: true,
  },
  { edge: 'left overlap exactly 1 pt', x0: 20, x1: 61, y: 100, inside: false },
  {
    edge: 'right overlap exactly 1 pt',
    x0: 99,
    x1: 140,
    y: 100,
    inside: false,
  },
  { edge: 'left overlap below 1 pt', x0: 20, x1: 60.9, y: 100, inside: false },
  {
    edge: 'right overlap below 1 pt',
    x0: 99.1,
    x1: 140,
    y: 100,
    inside: false,
  },
  { edge: '1 pt item inside box', x0: 70, x1: 71, y: 100, inside: false },
  {
    edge: 'sub-point item inside box',
    x0: 70,
    x1: 70.9,
    y: 100,
    inside: false,
  },
  { edge: 'top boundary', x0: 40, x1: 80, y: 93, inside: true },
  { edge: 'bottom boundary', x0: 40, x1: 80, y: 110, inside: true },
  { edge: 'top tolerance', x0: 40, x1: 80, y: 92, inside: true },
  { edge: 'bottom tolerance', x0: 40, x1: 80, y: 111, inside: true },
  { edge: 'beyond top tolerance', x0: 40, x1: 80, y: 91.9, inside: false },
  { edge: 'beyond bottom tolerance', x0: 40, x1: 80, y: 111.1, inside: false },
])(
  'block membership uses horizontal overlap over 1 pt and the vertical anchor with 1 pt tolerance: $edge',
  async ({ x0, x1, y, inside }) => {
    printed([{ ...item, x0, x1, baseline: y + 7 }]);
    const expected: ExpectedBlock[][] = [[{ box, texts: ['radius'] }]];
    expect(await missingText(new Uint8Array(), expected)).toEqual(
      inside ? [] : ['page 1: radius'],
    );
  },
);

test('a merged label/field item supplies both adjacent blocks but not a non-overlapping block', async () => {
  printed([
    { ...item, text: 'Meeting date:2026-10-24', x0: 56.68, x1: 190.78 },
  ]);
  const expected: ExpectedBlock[][] = [
    [
      { box: { ...box, x0: 56.68, x1: 129.4 }, texts: ['Meeting date:'] },
      { box: { ...box, x0: 129.4, x1: 190.78 }, texts: ['2026-10-24'] },
      { box: { ...box, x0: 192, x1: 250 }, texts: ['2026-10-24'] },
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([
    'page 1: 2026-10-24',
  ]);
});

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
