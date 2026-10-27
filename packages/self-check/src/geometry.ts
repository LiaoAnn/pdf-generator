// Affine matrices and rects shared by the PDF readers (pdf.ts, paints.ts).

export type Matrix = [number, number, number, number, number, number];
/** `[x0, y0, x1, y1]` in PDF user space (y up). */
export type Rect = [number, number, number, number];

export const identity: Matrix = [1, 0, 0, 1, 0, 0];

export const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The axis-aligned bounds of `rect` mapped through `m`. */
export function mapRect(m: Matrix, [x0, y0, x1, y1]: Rect): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as const) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const intersect = (a: Rect, b: Rect): Rect => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];

export const asMatrix = (value: unknown): Matrix | undefined =>
  Array.isArray(value) &&
  value.length === 6 &&
  value.every(n => typeof n === 'number')
    ? (value as Matrix)
    : undefined;

export const asRect = (value: unknown): Rect | undefined => {
  const values = ArrayBuffer.isView(value)
    ? Array.from(value as Float32Array)
    : value;
  return Array.isArray(values) &&
    values.length === 4 &&
    values.every(n => typeof n === 'number' && Number.isFinite(n)) &&
    values[0] <= values[2] &&
    values[1] <= values[3]
    ? (values as Rect)
    : undefined;
};

/** The inverse of `m`; none when it is singular. */
export const invert = ([a, b, c, d, e, f]: Matrix): Matrix | undefined => {
  const det = a * d - b * c;
  if (!det) return undefined;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
};
