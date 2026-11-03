// T07-19: missingText read every item's x range as horizontal text, so text
// rotated +90° or 180° (a stamp's 內部使用, an upside-down 倒置文字) was
// reported missing although it printed inside its box. readPdf reports `dir`
// for rotated items (T14-1): the item's advance runs along it from
// `(x0, baseline)` for `x1 - x0`, and its glyphs' "up" is the advance turned a
// quarter left (y down). Rotated text keeps the horizontal rule, turned with
// it: the anchor (0.35 em up from the baseline) must lie in the box within
// 1 pt across the advance, and overlap the box by more than 1 pt along it.
import { afterEach, expect, test, vi } from 'vitest';
import { type ExpectedBlock, missingText, type PdfTextItem } from './index.ts';
import * as pdfReader from './pdf.ts';

// 20 pt text, 40 pt advance: the anchor runs 7 pt "up" from the baseline.
// The glyphs reach 4 pt below their baseline and 18 pt above it.
const base = { text: 'radius', size: 20, font: 'FixtureFont' };

/** An item whose advance runs along `dir` from `origin` for 40 pt. */
const rotated = (
  dir: [number, number],
  origin: [number, number],
  text = base.text,
): PdfTextItem => ({
  ...base,
  text,
  x0: origin[0],
  x1: origin[0] + 40,
  baseline: origin[1],
  dir,
});

type Box = { x0: number; y0: number; x1: number; y1: number };

function printed(items: PdfTextItem[]) {
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
    pages: [{ width: 595, height: 842, items, marks: [], paints: [] }],
  });
}

afterEach(() => vi.restoreAllMocks());

const missing = (texts: { text: string; boxes: Box[] }[]) => {
  const expected: ExpectedBlock[][] = [[{ texts }]];
  return missingText(new Uint8Array(), expected);
};

// Each orientation's item and the axis-aligned box of its glyphs, as Chrome's
// client rects give it for the rotated text.
const plus90 = {
  // Advance down, glyph tops to the right: anchor x = 107, y 100 → 140.
  item: rotated([0, 1], [100, 100]),
  box: { x0: 96, y0: 100, x1: 118, y1: 140 },
};
const upsideDown = {
  // Advance to the left, glyph tops down: anchor y = 107, x 140 → 100.
  item: rotated([-1, 0], [140, 100]),
  box: { x0: 100, y0: 96, x1: 140, y1: 118 },
};
const minus90 = {
  // Advance up, glyph tops to the left: anchor x = 93, y 140 → 100.
  item: rotated([0, -1], [100, 140]),
  box: { x0: 82, y0: 100, x1: 104, y1: 140 },
};
const thirty = {
  // rotate(30deg): advance along (cos 30°, sin 30°); glyph corners span
  // x 98 → 143.64, y 84.41 → 123.46.
  item: rotated([Math.sqrt(3) / 2, 1 / 2], [100, 100]),
  box: { x0: 98, y0: 84, x1: 144, y1: 124 },
};

test.each([
  { name: '+90°', ...plus90 },
  { name: '180°', ...upsideDown },
  { name: '-90°', ...minus90 },
  { name: '30°', ...thirty },
])('$name text printed inside its box is found', async ({ item, box }) => {
  printed([item]);
  expect(await missing([{ text: 'radius', boxes: [box] }])).toEqual([]);
});

// The control: the same text with its box moved off the printed glyphs (by
// the box's own size, so the two only touch) is still reported missing.
test.each([
  { name: '+90° moved right', ...plus90, dx: 22, dy: 0 },
  { name: '+90° moved down', ...plus90, dx: 0, dy: 40 },
  { name: '180° moved left', ...upsideDown, dx: -40, dy: 0 },
  { name: '180° moved down', ...upsideDown, dx: 0, dy: 22 },
  { name: '-90° moved left', ...minus90, dx: -22, dy: 0 },
  { name: '-90° moved up', ...minus90, dx: 0, dy: -40 },
  { name: '30° moved right', ...thirty, dx: 46, dy: 0 },
  { name: '30° moved down', ...thirty, dx: 0, dy: 40 },
])(
  '$name text printed outside its box is still missing',
  async ({ item, box, dx, dy }) => {
    printed([item]);
    const moved = {
      x0: box.x0 + dx,
      y0: box.y0 + dy,
      x1: box.x1 + dx,
      y1: box.y1 + dy,
    };
    expect(await missing([{ text: 'radius', boxes: [moved] }])).toEqual([
      'page 1: radius',
    ]);
  },
);

// The horizontal table's boundaries (missing-text.test.ts), turned with the
// text: along the advance the overlap must exceed 1 pt; across it the anchor
// may lie up to 1 pt outside the box.
test.each([
  // Along +90°'s advance (y 100 → 140).
  {
    edge: '+90° overlap 0.5 pt',
    item: plus90.item,
    box: { ...plus90.box, y0: 139.5, y1: 160 },
    inside: false,
  },
  {
    edge: '+90° overlap 1 pt',
    item: plus90.item,
    box: { ...plus90.box, y0: 139, y1: 160 },
    inside: false,
  },
  {
    edge: '+90° overlap 1.1 pt',
    item: plus90.item,
    box: { ...plus90.box, y0: 138.9, y1: 160 },
    inside: true,
  },
  {
    edge: '+90° overlap 1.1 pt at its start',
    item: plus90.item,
    box: { ...plus90.box, y0: 80, y1: 101.1 },
    inside: true,
  },
  // Across +90°'s advance (anchor x = 107).
  {
    edge: '+90° anchor on the right edge',
    item: plus90.item,
    box: { ...plus90.box, x1: 107 },
    inside: true,
  },
  {
    edge: '+90° anchor 1 pt right of the box',
    item: plus90.item,
    box: { ...plus90.box, x1: 106 },
    inside: true,
  },
  {
    edge: '+90° anchor 1.1 pt right of the box',
    item: plus90.item,
    box: { ...plus90.box, x1: 105.9 },
    inside: false,
  },
  {
    edge: '+90° anchor 1 pt left of the box',
    item: plus90.item,
    box: { ...plus90.box, x0: 108 },
    inside: true,
  },
  {
    edge: '+90° anchor 1.1 pt left of the box',
    item: plus90.item,
    box: { ...plus90.box, x0: 108.1 },
    inside: false,
  },
  // Along 180°'s advance (x 140 → 100).
  {
    edge: '180° overlap 1 pt',
    item: upsideDown.item,
    box: { ...upsideDown.box, x0: 60, x1: 101 },
    inside: false,
  },
  {
    edge: '180° overlap 1.1 pt',
    item: upsideDown.item,
    box: { ...upsideDown.box, x0: 60, x1: 101.1 },
    inside: true,
  },
  {
    edge: '180° overlap 1 pt at its start',
    item: upsideDown.item,
    box: { ...upsideDown.box, x0: 139, x1: 180 },
    inside: false,
  },
  // Across 180°'s advance (anchor y = 107).
  {
    edge: '180° anchor 1 pt below the box',
    item: upsideDown.item,
    box: { ...upsideDown.box, y1: 106 },
    inside: true,
  },
  {
    edge: '180° anchor 1.1 pt below the box',
    item: upsideDown.item,
    box: { ...upsideDown.box, y1: 105.9 },
    inside: false,
  },
  {
    edge: '180° anchor 1 pt above the box',
    item: upsideDown.item,
    box: { ...upsideDown.box, y0: 108 },
    inside: true,
  },
  {
    edge: '180° anchor 1.1 pt above the box',
    item: upsideDown.item,
    box: { ...upsideDown.box, y0: 108.1 },
    inside: false,
  },
  // -90° (anchor x = 93, y 140 → 100).
  {
    edge: '-90° overlap 1 pt',
    item: minus90.item,
    box: { ...minus90.box, y0: 80, y1: 101 },
    inside: false,
  },
  {
    edge: '-90° overlap 1.1 pt',
    item: minus90.item,
    box: { ...minus90.box, y0: 80, y1: 101.1 },
    inside: true,
  },
  {
    edge: '-90° anchor 1 pt left of the box',
    item: minus90.item,
    box: { ...minus90.box, x0: 94 },
    inside: true,
  },
  {
    edge: '-90° anchor 1.1 pt left of the box',
    item: minus90.item,
    box: { ...minus90.box, x0: 94.1 },
    inside: false,
  },
])('rotated text-box membership: $edge', async ({ item, box, inside }) => {
  printed([item]);
  expect(await missing([{ text: 'radius', boxes: [box] }])).toEqual(
    inside ? [] : ['page 1: radius'],
  );
});

// Two +90° columns side by side, 25 pt apart: each text is found only in its
// own column, so a neighbouring column can't lend it characters.
test('a rotated column cannot lend its text to the neighbouring column', async () => {
  printed([
    rotated([0, 1], [100, 100], 'alpha'),
    rotated([0, 1], [125, 100], 'omega'),
  ]);
  const left = { x0: 96, y0: 100, x1: 118, y1: 140 };
  const right = { x0: 121, y0: 100, x1: 143, y1: 140 };
  expect(
    await missing([
      { text: 'alpha', boxes: [left] },
      { text: 'omega', boxes: [right] },
    ]),
  ).toEqual([]);
  expect(
    await missing([
      { text: 'alpha', boxes: [right] },
      { text: 'omega', boxes: [left] },
    ]),
  ).toEqual(['page 1: alpha', 'page 1: omega']);
});

// Rotated text that wraps prints one item per line; each line's box is one of
// the text's client rects. +90° lines stack to the left (against the glyphs'
// "up"), and the text is matched across them in content-stream order.
test('rotated text wrapped over two line boxes is found across both', async () => {
  printed([
    rotated([0, 1], [100, 100], 'radius'),
    rotated([0, 1], [76, 100], 'gauge'),
  ]);
  expect(
    await missing([
      {
        text: 'radius gauge',
        boxes: [
          { x0: 96, y0: 100, x1: 118, y1: 140 },
          { x0: 72, y0: 100, x1: 94, y1: 140 },
        ],
      },
    ]),
  ).toEqual([]);
});
