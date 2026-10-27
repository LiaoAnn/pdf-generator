import type { Box } from './check.ts';
import type { PdfGroup, PdfPaint, PdfShading, PdfShape } from './pdf.ts';

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
const bandSamples = 1 << 18;
const white = 0xffffff;

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

const rgb = (color: string) => Number.parseInt(color.slice(1), 16);

/** The colour of `stops` at `t`, linear between stops, flat past the ends. */
function stopColor(stops: PdfShading['stops'], t: number): number {
  const first = stops[0];
  if (!first) return white;
  if (t <= first[0]) return rgb(first[1]);
  for (let k = 1; k < stops.length; k++) {
    const [o1, c1] = stops[k] ?? first;
    if (t > o1) continue;
    const [o0, c0] = stops[k - 1] ?? first;
    const f = o1 > o0 ? (t - o0) / (o1 - o0) : 1;
    const [a, b] = [rgb(c0), rgb(c1)];
    let out = 0;
    for (const shift of [16, 8, 0]) {
      const from = (a >> shift) & 0xff;
      const to = (b >> shift) & 0xff;
      out |= Math.round(from + (to - from) * f) << shift;
    }
    return out;
  }
  return rgb((stops[stops.length - 1] ?? first)[1]);
}

/** A gradient's colour at page-frame point (x, y); undefined: not painted. */
function shadingColor(shading: PdfShading, x: number, y: number) {
  const [a, b, c, d, e, f] = shading.toShading;
  const u = a * x + c * y + e;
  const v = b * x + d * y + f;
  const [fx, fy] = shading.from;
  const [dx, dy] = [shading.to[0] - fx, shading.to[1] - fy];
  if (shading.kind === 'axial') {
    const length = dx * dx + dy * dy;
    const t = length > 0 ? ((u - fx) * dx + (v - fy) * dy) / length : 0;
    return stopColor(shading.stops, Math.min(1, Math.max(0, t)));
  }
  // The largest s whose circle, centre from + s (to - from) and radius
  // r0 + s (r1 - r0) >= 0, passes through (u, v).
  const { r0, r1 } = shading;
  const dr = r1 - r0;
  const [px, py] = [u - fx, v - fy];
  const qa = dx * dx + dy * dy - dr * dr;
  const qb = px * dx + py * dy + r0 * dr;
  const qc = px * px + py * py - r0 * r0;
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-12) {
    if (qb !== 0) roots.push(qc / (2 * qb));
  } else {
    const disc = qb * qb - qa * qc;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      roots.push((qb + root) / qa, (qb - root) / qa);
    }
  }
  const s = Math.max(...roots.filter(s => r0 + s * dr >= 0));
  return Number.isFinite(s)
    ? stopColor(shading.stops, Math.min(1, Math.max(0, s)))
    : undefined;
}

/** A layer of colours (negative: an unknown colour, one per paint) and alphas. */
interface Layer {
  group?: PdfGroup;
  color: Int32Array;
  alpha: Float32Array;
}

/** Composites `color` at `alpha` onto sample `i` of `layer`, source-over. */
function composite(layer: Layer, i: number, color: number, alpha: number) {
  const under = layer.alpha[i] ?? 0;
  const out = alpha + under * (1 - alpha);
  if (out <= 0) return;
  const below = layer.color[i] ?? white;
  let mixed = color;
  if (alpha < 1 && under > 0 && color >= 0) {
    if (below < 0) mixed = below;
    else {
      mixed = 0;
      for (const shift of [16, 8, 0]) {
        const top = (color >> shift) & 0xff;
        const bottom = (below >> shift) & 0xff;
        mixed |=
          Math.round((top * alpha + bottom * under * (1 - alpha)) / out) <<
          shift;
      }
    }
  }
  layer.color[i] = mixed;
  layer.alpha[i] = out;
}

/** Whether two colours differ by more than rounding. */
function differ(a: number, b: number): boolean {
  if (a === b) return false;
  if (a < 0 || b < 0) return true;
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
    .filter(
      paint =>
        (paint.groups ?? []).reduce(
          (a, group) => a * group.alpha,
          paint.alpha,
        ) > 0 && overlaps(paint.box, region),
    )
    .map((paint, k) => ({
      paint,
      // A paint of no colour (an image) differs from every other paint.
      color:
        paint.color && /^#[0-9a-f]{6}$/i.test(paint.color)
          ? rgb(paint.color)
          : -1 - k,
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
    const n = cols * grid.rows;
    const clipSpans = new Map<PdfShape, Spans>();
    const spansOf = relevant.map(({ paint }) => {
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
      return spans;
    });
    // Paints in order over a white page, each group composited on its own
    // layer, then onto the one under it at the group's alpha.
    const render = (backgroundOnly: boolean) => {
      const stack: Layer[] = [
        {
          color: new Int32Array(n).fill(white),
          alpha: new Float32Array(n).fill(1),
        },
      ];
      const close = () => {
        const layer = stack.pop();
        const under = stack[stack.length - 1];
        if (!layer?.group || !under) return;
        for (let i = 0; i < n; i++) {
          const alpha = layer.alpha[i] ?? 0;
          if (alpha > 0) {
            composite(
              under,
              i,
              layer.color[i] ?? white,
              alpha * layer.group.alpha,
            );
          }
        }
      };
      relevant.forEach(({ paint, color, background }, k) => {
        if (backgroundOnly && !background) return;
        const groups = paint.groups ?? [];
        let common = 0;
        while (
          common < groups.length &&
          stack[common + 1]?.group?.id === groups[common]?.id
        ) {
          common++;
        }
        while (stack.length - 1 > common) close();
        for (const group of groups.slice(common)) {
          stack.push({
            group,
            color: new Int32Array(n),
            alpha: new Float32Array(n),
          });
        }
        const top = stack[stack.length - 1];
        if (!top) return;
        spansOf[k]?.forEach((row, r) => {
          const y = grid.oy + (r + 0.5) * step;
          for (let j = 0; j < row.length; j += 2) {
            for (let c = row[j] ?? 0; c < (row[j + 1] ?? 0); c++) {
              const at = paint.shading
                ? shadingColor(paint.shading, grid.ox + (c + 0.5) * step, y)
                : color;
              if (at !== undefined)
                composite(top, r * cols + c, at, paint.alpha);
            }
          }
        });
      });
      while (stack.length > 1) close();
      return stack[0]?.color ?? new Int32Array(n);
    };
    const all = render(false);
    const back = render(true);
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
