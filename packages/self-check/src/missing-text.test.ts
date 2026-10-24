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
    pages: [{ width: 595, height: 842, items, marks: [] }],
  });
}

afterEach(() => vi.restoreAllMocks());

const block = (texts: string[], bounds = box): ExpectedBlock => ({
  texts: texts.map(text => ({ text, boxes: [bounds] })),
});

test('KaTeX zero-width-only struts need no PDF item or geometry', async () => {
  printed([]);
  expect(
    await missingText(new Uint8Array(), [
      [{ texts: [{ text: '\u200b', boxes: [] }] }],
    ]),
  ).toEqual([]);
});

test('zero-width struts in expected or printed text do not make a visible word missing', async () => {
  printed([{ ...item, text: 'ra\u200bdius' }]);
  expect(
    await missingText(new Uint8Array(), [[block(['r\u200badius\u200b'])]]),
  ).toEqual([]);
});

test('numeric cells cannot consume a cross-cell occurrence before their own printed occurrences', async () => {
  const values = ['3.19', '3.01', '3.01', '93.01'];
  printed(
    values.map((text, at) => ({
      ...item,
      text,
      x0: at * 100,
      x1: at * 100 + 40,
    })),
  );
  const expected: ExpectedBlock[][] = [
    [
      {
        texts: values.map((text, at) => ({
          text,
          boxes: [{ ...box, x0: at * 100, x1: at * 100 + 40 }],
        })),
      },
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([]);
});

test('a missing numeric cell cannot borrow a cross-cell substring from its neighbours', async () => {
  printed([
    { ...item, text: '3.19', x0: 0, x1: 40 },
    { ...item, text: '3.01', x0: 100, x1: 140 },
  ]);
  const expected: ExpectedBlock[][] = [
    [
      {
        texts: ['3.19', '3.01', '93.01'].map((text, at) => ({
          text,
          boxes: [{ ...box, x0: at * 100, x1: at * 100 + 40 }],
        })),
      },
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([
    'page 1: 93.01',
  ]);
});

test('a repeated text requires separate printed characters within the same block', async () => {
  printed([{ ...item, text: 'TOKEN TOKEN' }]);
  expect(
    await missingText(new Uint8Array(), [[block(['TOKEN', 'TOKEN', 'TOKEN'])]]),
  ).toEqual(['page 1: TOKEN']);
});

test('longest-first matching keeps a leading letter from consuming a longer word in a shared item', async () => {
  printed([{ ...item, text: 'the radius r' }]);
  expect(
    await missingText(new Uint8Array(), [[block(['r', 'the radius'])]]),
  ).toEqual([]);
});

test('a ligature-split text matches normalized characters across PDF items', async () => {
  printed(['of', 'ﬁ', 'ce'].map(text => ({ ...item, text })));
  expect(await missingText(new Uint8Array(), [[block(['office'])]])).toEqual(
    [],
  );
});

test('missing diagnostics preserve DOM text order rather than longest-first matching order', async () => {
  printed([]);
  vi.mocked(pdfReader.readPdf).mockResolvedValue({ pages: [] });
  expect(
    await missingText(new Uint8Array(), [
      [],
      [block(['x', 'long missing text', 'Z'.repeat(60)])],
    ]),
  ).toEqual([
    'page 2: x',
    'page 2: long missing text',
    `page 2: ${'Z'.repeat(40)}`,
  ]);
});

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
  'text-box membership uses horizontal overlap over 1 pt and the vertical anchor with 1 pt tolerance: $edge',
  async ({ x0, x1, y, inside }) => {
    printed([{ ...item, x0, x1, baseline: y + 7 }]);
    const expected: ExpectedBlock[][] = [[block(['radius'])]];
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
      block(['Meeting date:'], { ...box, x0: 56.68, x1: 129.4 }),
      block(['2026-10-24'], { ...box, x0: 129.4, x1: 190.78 }),
      block(['2026-10-24'], { ...box, x0: 192, x1: 250 }),
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([
    'page 1: 2026-10-24',
  ]);
});

test('nested blocks independently reuse the same printed occurrence', async () => {
  printed([item]);
  const expected: ExpectedBlock[][] = [
    [block(['radius'], { x0: 0, y0: 0, x1: 300, y1: 300 }), block(['radius'])],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([]);
});

test('line-fragment boxes select items in content-stream order without admitting text in their union gap', async () => {
  printed([
    { ...item, text: 'first', x0: 0, x1: 40, baseline: 27 },
    { ...item, text: 'DECOY', x0: 0, x1: 40, baseline: 47 },
    { ...item, text: 'second', x0: 0, x1: 40, baseline: 67 },
  ]);
  const boxes = [
    { x0: 0, x1: 40, y0: 55, y1: 65 },
    { x0: 0, x1: 40, y0: 15, y1: 25 },
  ];
  const expected: ExpectedBlock[][] = [
    [
      {
        texts: [
          { text: 'first second', boxes },
          { text: 'DECOY', boxes },
        ],
      },
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([
    'page 1: DECOY',
  ]);
});

test('overlapping fragments cannot count the same PDF item twice for a repeated text', async () => {
  printed([{ ...item, text: 'TOKEN' }]);
  const expected: ExpectedBlock[][] = [
    [{ texts: [{ text: 'TOKEN TOKEN', boxes: [box, { ...box, x0: 61 }] }] }],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([
    'page 1: TOKEN TOKEN',
  ]);
});

test('texts with different boxes share consumed characters in a merged PDF item within one block', async () => {
  printed([{ ...item, text: 'TOKEN', x0: 0, x1: 100 }]);
  const expected: ExpectedBlock[][] = [
    [
      {
        texts: [
          { text: 'TOKEN', boxes: [{ ...box, x0: 0, x1: 50 }] },
          { text: 'TOKEN', boxes: [{ ...box, x0: 50, x1: 100 }] },
        ],
      },
    ],
  ];
  expect(await missingText(new Uint8Array(), expected)).toEqual([
    'page 1: TOKEN',
  ]);
});
