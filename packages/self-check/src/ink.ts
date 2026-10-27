import type { Box } from './check.ts';
import type {
  PdfGroup,
  PdfImage,
  PdfMask,
  PdfMatrix,
  PdfMesh,
  PdfPaint,
  PdfShading,
  PdfShape,
  PdfTile,
} from './pdf.ts';

/** What a page's paints leave visible in one box (T14-9). */
export interface Ink {
  /** The bounds of the ink, in the box plus its margin; none: no ink. */
  box: Box | undefined;
  /** The share of the box's width and of its height the ink spans. */
  coverage: [x: number, y: number];
  /** Whether paint whose colour can't be measured covers part of the box or its margin. */
  unmeasured: boolean;
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

const apply = ([a, b, c, d, e, f]: PdfMatrix, x: number, y: number) => [
  a * x + c * y + e,
  b * x + d * y + f,
];

const uv = (m: PdfMatrix, x: number, y: number): [number, number] => {
  const [u = 0, v = 0] = apply(m, x, y);
  return [u, v];
};

/** A colour and its alpha (0 to 1); none: nothing painted there. */
type Sample = [color: number, alpha: number] | undefined;

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

/** A gradient's colour at shading-space point (u, v); none: not painted. */
function gradientColor(shading: PdfShading, u: number, v: number) {
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

/** A grid over a mesh's bounds, each cell listing the triangles touching it. */
interface MeshIndex {
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  cells: number[][];
}

const meshIndexes = new WeakMap<PdfMesh, MeshIndex>();

function meshIndex(mesh: PdfMesh): MeshIndex {
  const known = meshIndexes.get(mesh);
  if (known) return known;
  const { positions, count } = mesh;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < count; k++) {
    const x = positions[2 * k] ?? 0;
    const y = positions[2 * k + 1] ?? 0;
    [x0, y0, x1, y1] = [
      Math.min(x0, x),
      Math.min(y0, y),
      Math.max(x1, x),
      Math.max(y1, y),
    ];
  }
  const side = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(count / 3))));
  const cell = Math.max(x1 - x0, y1 - y0, 1e-9) / side;
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let t = 0; t + 2 < count; t += 3) {
    const xs = [0, 1, 2].map(k => positions[2 * (t + k)] ?? 0);
    const ys = [0, 1, 2].map(k => positions[2 * (t + k) + 1] ?? 0);
    const c0 = Math.floor((Math.min(...xs) - x0) / cell);
    const c1 = Math.floor((Math.max(...xs) - x0) / cell);
    const r0 = Math.floor((Math.min(...ys) - y0) / cell);
    const r1 = Math.floor((Math.max(...ys) - y0) / cell);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) cells[r * cols + c]?.push(t);
    }
  }
  const index = { x0, y0, cell, cols, rows, cells };
  meshIndexes.set(mesh, index);
  return index;
}

/** A mesh's colour at shading-space point (u, v); none: in no triangle. */
function meshColor(mesh: PdfMesh, u: number, v: number) {
  const { x0, y0, cell, cols, rows, cells } = meshIndex(mesh);
  const c = Math.floor((u - x0) / cell);
  const r = Math.floor((v - y0) / cell);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return undefined;
  const { positions, colors } = mesh;
  const triangles = cells[r * cols + c] ?? [];
  for (let k = triangles.length - 1; k >= 0; k--) {
    const t = triangles[k] ?? 0;
    const at = (j: number) => positions[2 * t + j] ?? 0;
    const [ax, ay, bx, by, cx, cy] = [at(0), at(1), at(2), at(3), at(4), at(5)];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) continue;
    const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det;
    const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det;
    const l3 = 1 - l1 - l2;
    const e = -1e-9;
    if (l1 < e || l2 < e || l3 < e) continue;
    let out = 0;
    for (const [channel, shift] of [
      [0, 16],
      [1, 8],
      [2, 0],
    ] as const) {
      const value =
        l1 * (colors[4 * t + channel] ?? 0) +
        l2 * (colors[4 * (t + 1) + channel] ?? 0) +
        l3 * (colors[4 * (t + 2) + channel] ?? 0);
      out |= Math.round(value) << shift;
    }
    return out;
  }
  return undefined;
}

/** An image's colour and alpha at page-frame point (x, y). */
function imageSample(image: PdfImage, x: number, y: number): Sample {
  const [u = 0, v = 0] = apply(image.toImage, x, y);
  if (!(u >= 0 && u < 1 && v > 0 && v <= 1)) return undefined;
  const column = Math.min(image.width - 1, Math.floor(u * image.width));
  const row = Math.min(image.height - 1, Math.floor((1 - v) * image.height));
  const p = 4 * (row * image.width + column);
  const { rgba } = image;
  return [
    ((rgba[p] ?? 0) << 16) | ((rgba[p + 1] ?? 0) << 8) | (rgba[p + 2] ?? 0),
    (rgba[p + 3] ?? 0) / 255,
  ];
}

/** Whether a shape contains (x, y), by its fill rule. */
function contains({ polygons, rule }: PdfShape, x: number, y: number) {
  let winding = 0;
  for (const points of polygons) {
    const n = points.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [xa = 0, ya = 0] = [points[2 * i], points[2 * i + 1]];
      const [xb = 0, yb = 0] = [points[2 * j], points[2 * j + 1]];
      if (ya <= y === yb <= y) continue;
      const cross = xa + ((y - ya) * (xb - xa)) / (yb - ya);
      if (cross > x) winding += ya < yb ? 1 : -1;
    }
  }
  return rule === 'evenodd' ? (winding & 1) !== 0 : winding !== 0;
}

const groupAlpha = (groups: readonly PdfGroup[] | undefined) =>
  (groups ?? []).reduce((alpha, group) => alpha * group.alpha, 1);

/** `top` at its alpha over `under`, source-over; either may be none. */
function over(under: Sample, top: Sample): Sample {
  if (!top || top[1] <= 0) return under;
  if (!under || under[1] <= 0 || top[1] >= 1) return top;
  const [tc, ta] = top;
  const [uc, ua] = under;
  const out = ta + ua * (1 - ta);
  let color = 0;
  for (const shift of [16, 8, 0]) {
    const t = (tc >> shift) & 0xff;
    const u = (uc >> shift) & 0xff;
    color |= Math.round((t * ta + u * ua * (1 - ta)) / out) << shift;
  }
  return [color, out];
}

/**
 * Paints composited at one point (a tile's, a mask's), over nothing; a
 * group's alpha is applied to each of its paints there.
 */
function composeAt(paints: readonly PdfPaint[], x: number, y: number): Sample {
  let result: Sample;
  for (const paint of paints) {
    if (!contains(paint, x, y) || !paint.clips.every(c => contains(c, x, y))) {
      continue;
    }
    const sample = paintSample(paint, x, y);
    if (sample) {
      result = over(result, [
        sample[0],
        sample[1] * paint.alpha * groupAlpha(paint.groups),
      ]);
    }
  }
  return result;
}

/** What a soft mask lets through at (x, y), 0 to 1. */
function maskAt(mask: PdfMask, x: number, y: number): number {
  const sample = composeAt(mask.paints, x, y);
  if (!mask.luminosity) return sample?.[1] ?? 0;
  const [color] = over([rgb(mask.backdrop), 1], sample) ?? [0, 1];
  return (
    (0.3 * ((color >> 16) & 0xff) +
      0.59 * ((color >> 8) & 0xff) +
      0.11 * (color & 0xff)) /
    255
  );
}

/**
 * A paint's own colour and alpha at (x, y), inside its shape: its colour,
 * gradient, mesh, image pixel or tile, through its soft mask.
 */
function paintSample(paint: PdfPaint, x: number, y: number): Sample {
  let sample: Sample;
  if (paint.color !== undefined) sample = [rgb(paint.color), 1];
  else if (paint.shading || paint.mesh) {
    const color = paint.shading
      ? gradientColor(paint.shading, ...uv(paint.shading.toShading, x, y))
      : paint.mesh && meshColor(paint.mesh, ...uv(paint.mesh.toShading, x, y));
    sample = color === undefined ? undefined : [color, 1];
  } else if (paint.image) sample = imageSample(paint.image, x, y);
  else if (paint.tile) sample = tileSample(paint.tile, x, y);
  if (!sample || !paint.mask) return sample;
  return [sample[0], sample[1] * maskAt(paint.mask, x, y)];
}

/** A tiling pattern's colour and alpha at page-frame point (x, y). */
function tileSample(tile: PdfTile, x: number, y: number): Sample {
  const [u = 0, v = 0] = apply(tile.toPattern, x, y);
  const [x0, y0] = tile.bbox;
  const [sx, sy] = tile.step;
  const wrap = (value: number, origin: number, period: number) =>
    origin + ((((value - origin) % period) + period) % period);
  return composeAt(tile.paints, wrap(u, x0, sx), wrap(v, y0, sy));
}

/** A layer of colours and alphas. */
interface Layer {
  group?: PdfGroup;
  color: Int32Array;
  alpha: Float32Array;
}

/** Composites `color` at `alpha` onto sample `i` of `layer`, source-over. */
function composite(layer: Layer, i: number, color: number, alpha: number) {
  const result = over(
    [layer.color[i] ?? white, layer.alpha[i] ?? 0],
    [color, alpha],
  );
  if (!result) return;
  layer.color[i] = result[0];
  layer.alpha[i] = result[1];
}

/** Whether two colours differ by more than rounding. */
function differ(a: number, b: number): boolean {
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
    .map(paint => ({
      paint,
      // A plain colour, unmasked: the same at every point.
      color:
        paint.color !== undefined && !paint.mask ? rgb(paint.color) : undefined,
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
  let unmeasured = false;
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
    // Samples under a tiling pattern: never ink (its colour isn't known).
    const tiles = new Uint8Array(n);
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
      if (paint.unmeasured) {
        spans.forEach((row, r) => {
          for (let j = 0; j < row.length; j += 2) {
            tiles.fill(
              1,
              r * cols + (row[j] ?? 0),
              r * cols + (row[j + 1] ?? 0),
            );
          }
        });
      }
      return spans;
    });
    if (tiles.includes(1)) unmeasured = true;
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
        if ((backgroundOnly && !background) || paint.unmeasured) return;
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
              const at: Sample =
                color === undefined
                  ? paintSample(paint, grid.ox + (c + 0.5) * step, y)
                  : [color, 1];
              if (at) composite(top, r * cols + c, at[0], at[1] * paint.alpha);
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
        if (!tiles[i] && differ(all[i] ?? white, back[i] ?? white)) {
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
  if (first(inkCols) < 0)
    return { box: undefined, coverage: [0, 0], unmeasured };
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
    unmeasured,
  };
}
