import { expect, test } from 'vitest';
import { compareInk } from './compare-renderers.ts';

// Synthetic page images, so each case pins one rule of the measurement
// without depending on how either renderer draws. Pixel rects are
// [x0, y0, x1, y1), on an opaque white page.
type Rect = readonly [number, number, number, number];

function page(
  width: number,
  height: number,
  dark: Rect[],
  rgba: readonly [number, number, number, number] = [0, 0, 0, 255],
) {
  const pixels = new Uint8Array(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1] of dark)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) pixels.set(rgba, (y * width + x) * 4);
  return { width, height, rgba: pixels };
}

test('identical pages agree: equal shares, position 0', () => {
  const drawn = page(20, 10, [[2, 2, 7, 6]]);
  const ink = compareInk(drawn, drawn, [0, 0, 10, 5], 2);
  expect(ink.pdfjs).toBeCloseTo(20 / 200);
  expect(ink.pdfium).toBeCloseTo(20 / 200);
  expect(ink.position).toBe(0);
});

test('shares keep their definition: pixel centres inside the box, dark below mid-grey over white', () => {
  // Box [1.2, 0, 3, 1] at scale 1 holds pixel columns 1 and 2 (centres 1.5
  // and 2.5; column 0's centre 0.5 is outside, though black). Column 1 is
  // black at alpha 200 (luminance 55 over white: dark), column 2 at alpha
  // 100 (155: not dark).
  const drawn = page(4, 1, [[0, 0, 2, 1]], [0, 0, 0, 200]);
  drawn.rgba.set([0, 0, 0, 100], 2 * 4);
  const ink = compareInk(drawn, drawn, [1.2, 0, 3, 1], 1);
  expect(ink.pdfjs).toBe(0.5);
  expect(ink.pdfium).toBe(0.5);
});

test('the same amount of ink in a different 4 pt cell counts as position', () => {
  // Box 8 × 4 pt at scale 1: two 4 pt cells. pdf.js inks the left one,
  // PDFium the right one: the shares agree, the position is entirely off.
  const ink = compareInk(
    page(8, 4, [[0, 0, 4, 4]]),
    page(8, 4, [[4, 0, 8, 4]]),
    [0, 0, 8, 4],
    1,
  );
  expect(ink.pdfjs).toBe(0.5);
  expect(ink.pdfium).toBe(0.5);
  expect(ink.position).toBe(1);
});

test('a shift inside one 4 pt cell does not count, so sub-cell rendering differences agree', () => {
  // One 4 × 4 pt cell: left half against right half.
  const ink = compareInk(
    page(4, 4, [[0, 0, 2, 4]]),
    page(4, 4, [[2, 0, 4, 4]]),
    [0, 0, 4, 4],
    1,
  );
  expect(ink.position).toBe(0);
});

test('cells are 4 pt at any scale', () => {
  // Scale 2: a 4 pt cell is 8 px. Halves of one 4 × 4 pt box share a cell;
  // halves of an 8 × 4 pt box are two cells.
  const oneCell = compareInk(
    page(8, 8, [[0, 0, 4, 8]]),
    page(8, 8, [[4, 0, 8, 8]]),
    [0, 0, 4, 4],
    2,
  );
  expect(oneCell.position).toBe(0);
  const twoCells = compareInk(
    page(16, 8, [[0, 0, 8, 8]]),
    page(16, 8, [[8, 0, 16, 8]]),
    [0, 0, 8, 4],
    2,
  );
  expect(twoCells.position).toBe(1);
});

test('position is each cell’s dark-pixel difference summed over the box’s pixels, partial cells included', () => {
  // Box 6 × 4 pt at scale 1: a full cell (16 px) and a 2 px wide partial
  // cell (8 px). pdf.js inks the partial cell, PDFium two columns of the
  // full cell: 8 dark pixels each, |8 − 0| + |0 − 8| over 24 pixels.
  const ink = compareInk(
    page(6, 4, [[4, 0, 6, 4]]),
    page(6, 4, [[0, 0, 2, 4]]),
    [0, 0, 6, 4],
    1,
  );
  expect(ink.pdfjs).toBeCloseTo(8 / 24);
  expect(ink.pdfium).toBeCloseTo(8 / 24);
  expect(ink.position).toBeCloseTo(16 / 24);
});

test('cells start at the box’s top-left pixel, not the page origin', () => {
  // Box x 2..10 at scale 1: cells x 2–5 and 6–9. pdf.js inks the first,
  // PDFium the second. Cells from the page origin (0–3, 4–7, 8–11) would
  // give 0.5.
  const ink = compareInk(
    page(12, 4, [[2, 0, 6, 4]]),
    page(12, 4, [[6, 0, 10, 4]]),
    [2, 0, 10, 4],
    1,
  );
  expect(ink.position).toBe(1);
});

test('a missing page counts as blank', () => {
  const ink = compareInk(
    page(4, 4, [[0, 0, 4, 4]]),
    undefined,
    [0, 0, 4, 4],
    1,
  );
  expect(ink).toEqual({ pdfjs: 1, pdfium: 0, position: 1 });
  expect(compareInk(undefined, undefined, [0, 0, 4, 4], 1)).toEqual({
    pdfjs: 0,
    pdfium: 0,
    position: 0,
  });
});

test('a box no pixel centre falls into measures 0', () => {
  const black = page(4, 4, [[0, 0, 4, 4]]);
  expect(compareInk(black, black, [1.1, 1.1, 1.4, 1.4], 1)).toEqual({
    pdfjs: 0,
    pdfium: 0,
    position: 0,
  });
});
