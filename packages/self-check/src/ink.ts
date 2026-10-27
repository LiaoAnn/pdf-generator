import type { Box } from './check.ts';
import type { PdfPaint, PdfShape } from './pdf.ts';

/** What a page's paints leave visible in one box (T14-9). */
export interface Ink {
  /** The bounds of the ink, in the box plus its margin; none: no ink. */
  box: Box | undefined;
  /** The share of the box's width and of its height the ink spans. */
  coverage: [x: number, y: number];
}

/** Sample spacing in PDF points: a quarter of the 1 pt ink tolerance. */
const step = 0.25;
/**
 * Samples rendered at once. A larger box is rendered in bands of rows at the
 * same spacing, so its size changes the time it takes, not the answer.
 */
const bandSamples = 1 << 20;
const white = 0xffffff;
/** A colour that differs from every colour: an image's, a shading's. */
const unknown = -1;

/** Per row, the sample columns a shape covers: `[c0, c1, c0, c1, …]`, c1 exclusive. */
type Spans = number[][];

/** The rows `[oy + (r + 0.5) * step]` and columns of one band. */
interface Grid {
  ox: number;
  oy: number;
  cols: number;
  rows: number;
}

/** The sample columns and rows a shape covers in `grid`, by its fill rule. */
function shapeSpans({ polygons, rule }: PdfShape, grid: Grid): Spans {
  const { ox, oy, cols, rows } = grid;
  const crossings: [x: number, winding: number][][] = Array.from(
    { length: rows },
    () => [],
  );
  for (const points of polygons) {
    const n = points.length >> 1;
    for (let i = 0; i < n; i++) {
      const xa = points[2 * i] ?? 0;
      const ya = points[2 * i + 1] ?? 0;
      const j = (i + 1) % n;
      const xb = points[2 * j] ?? 0;
      const yb = points[2 * j + 1] ?? 0;
      if (ya === yb) continue;
      const [top, bottom] = ya < yb ? [ya, yb] : [yb, ya];
      // Rows whose sample line y satisfies top <= y < bottom.
      const r0 = Math.max(0, Math.ceil((top - oy) / step - 0.5));
      const r1 = Math.min(rows - 1, Math.ceil((bottom - oy) / step - 0.5) - 1);
      const winding = ya < yb ? 1 : -1;
      for (let r = r0; r <= r1; r++) {
        const y = oy + (r + 0.5) * step;
        crossings[r]?.push([xa + ((y - ya) * (xb - xa)) / (yb - ya), winding]);
      }
    }
  }
  const inside = (winding: number) =>
    rule === 'evenodd' ? (winding & 1) !== 0 : winding !== 0;
  return crossings.map(row => {
    const spans: number[] = [];
    row.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    let start = 0;
    for (const [x, w] of row) {
      const was = inside(winding);
      winding += w;
      if (!was && inside(winding)) start = x;
      else if (was && !inside(winding)) {
        // Columns whose sample x satisfies start <= x < end.
        const c0 = Math.max(0, Math.ceil((start - ox) / step - 0.5));
        const c1 = Math.min(cols, Math.ceil((x - ox) / step - 0.5));
        if (c1 > c0) spans.push(c0, c1);
      }
    }
    return spans;
  });
}

/** The columns both span lists cover. */
function intersectSpans(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i] ?? 0, b[j] ?? 0);
    const hi = Math.min(a[i + 1] ?? 0, b[j + 1] ?? 0);
    if (hi > lo) out.push(lo, hi);
    if ((a[i + 1] ?? 0) < (b[j + 1] ?? 0)) i += 2;
    else j += 2;
  }
  return out;
}

const parseColor = (color: string | undefined): number => {
  const value =
    color === undefined ? Number.NaN : Number.parseInt(color.slice(1), 16);
  return /^#[0-9a-f]{6}$/i.test(color ?? '') ? value : unknown;
};

/** `color` at `alpha` over `under`, source-over. */
function blend(under: number, color: number, alpha: number): number {
  if (alpha >= 1 || color === unknown || under === unknown) {
    return alpha >= 1 || color === unknown ? color : unknown;
  }
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const top = (color >> shift) & 0xff;
    const bottom = (under >> shift) & 0xff;
    out |= Math.round(top * alpha + bottom * (1 - alpha)) << shift;
  }
  return out;
}

/** Whether two colours differ by more than rounding. */
function differ(a: number, b: number): boolean {
  if (a === b) return false;
  if (a === unknown || b === unknown) return true;
  for (const shift of [16, 8, 0]) {
    if (Math.abs(((a >> shift) & 0xff) - ((b >> shift) & 0xff)) > 1) {
      return true;
    }
  }
  return false;
}

const overlaps = (a: Box, b: Box) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * The ink in `box` plus `margin` on each side: the points whose colour with
 * every paint differs from their colour with only the background paints.
 * Points are sampled every 0.25 pt; each counts for its 0.25 pt cell.
 */
export function measureInk(
  paints: readonly PdfPaint[],
  box: Box,
  margin: number,
  isBackground: (paint: PdfPaint) => boolean,
): Ink {
  const [x0, y0, x1, y1] = box;
  const region: Box = [x0 - margin, y0 - margin, x1 + margin, y1 + margin];
  const cols = Math.max(1, Math.ceil((region[2] - region[0]) / step));
  const rows = Math.max(1, Math.ceil((region[3] - region[1]) / step));
  const relevant = paints
    .filter(paint => paint.alpha > 0 && overlaps(paint.box, region))
    .map(paint => ({
      paint,
      color: parseColor(paint.color),
      background: isBackground(paint),
    }));
  const inkCols = new Uint8Array(cols);
  const inkRows = new Uint8Array(rows);
  // Ink inside the box itself, for its coverage.
  const boxCols = new Uint8Array(cols);
  const boxRows = new Uint8Array(rows);
  const inBox = (origin: number, k: number, b0: number, b1: number) => {
    const at = origin + (k + 0.5) * step;
    return at >= b0 && at <= b1;
  };
  const bandRows = Math.max(1, Math.floor(bandSamples / cols));
  for (let r0 = 0; r0 < rows; r0 += bandRows) {
    const grid: Grid = {
      ox: region[0],
      oy: region[1] + r0 * step,
      cols,
      rows: Math.min(bandRows, rows - r0),
    };
    const all = new Int32Array(cols * grid.rows).fill(white);
    const back = new Int32Array(cols * grid.rows).fill(white);
    const clipSpans = new Map<PdfShape, Spans>();
    for (const { paint, color, background } of relevant) {
      let spans = shapeSpans(paint, grid);
      for (const clip of paint.clips) {
        let clipped = clipSpans.get(clip);
        if (!clipped) {
          clipped = shapeSpans(clip, grid);
          clipSpans.set(clip, clipped);
        }
        const cut = clipped;
        spans = spans.map((row, r) =>
          row.length === 0 ? row : intersectSpans(row, cut[r] ?? []),
        );
      }
      spans.forEach((row, r) => {
        for (let k = 0; k < row.length; k += 2) {
          for (let c = row[k] ?? 0; c < (row[k + 1] ?? 0); c++) {
            const i = r * cols + c;
            all[i] = blend(all[i] ?? white, color, paint.alpha);
            if (background)
              back[i] = blend(back[i] ?? white, color, paint.alpha);
          }
        }
      });
    }
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (differ(all[i] ?? white, back[i] ?? white)) {
          inkCols[c] = 1;
          inkRows[r0 + r] = 1;
          if (inBox(region[0], c, x0, x1) && inBox(region[1], r0 + r, y0, y1)) {
            boxCols[c] = 1;
            boxRows[r0 + r] = 1;
          }
        }
      }
    }
  }
  const first = (cells: Uint8Array) => cells.indexOf(1);
  const last = (cells: Uint8Array) => cells.lastIndexOf(1);
  if (first(inkCols) < 0) return { box: undefined, coverage: [0, 0] };
  // The share of the box's span whose cells hold ink inside the box.
  const share = (cells: Uint8Array, b0: number, b1: number) =>
    b1 > b0
      ? Math.min(1, (cells.reduce((n, ink) => n + ink, 0) * step) / (b1 - b0))
      : 0;
  return {
    box: [
      region[0] + first(inkCols) * step,
      region[1] + first(inkRows) * step,
      region[0] + (last(inkCols) + 1) * step,
      region[1] + (last(inkRows) + 1) * step,
    ],
    coverage: [share(boxCols, x0, x1), share(boxRows, y0, y1)],
  };
}
