import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';

/** One run of text in a PDF page's text layer. */
export interface PdfTextItem {
  /** The text as the PDF's text layer has it (not normalised). */
  text: string;
  /** Left and right edge, in PDF points from the page's left edge. */
  x0: number;
  x1: number;
  /** Baseline, in PDF points from the page's top edge (y down). */
  baseline: number;
  /** Font size in PDF points. */
  size: number;
  /** Embedded font name without the subset tag, e.g. `NotoSansTC-Regular`. */
  font: string /**
   * Rotated text only: the unit vector its advance runs along, in the same
   * frame (x right, y down). `x0` and `baseline` are then its origin and
   * `x1 - x0` its advance's length. Left out for horizontal text.
   */;
  dir?: [number, number];
}

/** Something a page draws besides text. */
export interface PdfMark {
  /**
   * `image`: a painted image (raster XObject, inline or mask image).
   * `path`: a filled or stroked path, or a shading over the clip.
   * `clip`: a clipping path (Chrome clips every `<img>` and `<svg>` to its box).
   */
  kind: 'image' | 'path' | 'clip';
  /**
   * `[x0, y0, x1, y1]` in PDF points from the page's top-left corner, as text
   * items; inside the clip in force (a stroke includes half its width).
   */
  box: [number, number, number, number];
}

/**
 * A region bounded by closed polygons, each a flat `[x0, y0, x1, y1, …]` list
 * of points in PDF points from the page's top-left corner (y down), curves
 * flattened. A point is inside by the nonzero or the even-odd rule.
 */
export interface PdfShape {
  polygons: number[][];
  rule: 'nonzero' | 'evenodd';
}

/** One transparency group: `id` tells two groups with the same alpha apart. */
export interface PdfGroup {
  id: number;
  alpha: number;
}

/**
 * An axial or radial gradient (PDF shading types 2 and 3, extended at both
 * ends). Axial: the colour at a point is the stop colour at its projection's
 * position from `from` to `to`. Radial: at the largest `s` in [0, 1] whose
 * circle (centre from `from` to `to`, radius from `r0` to `r1`) passes
 * through the point; no such circle: the point isn't painted.
 */
export interface PdfShading {
  kind: 'axial' | 'radial';
  /** Offsets from 0 to 1, in order, each with a `#rrggbb` colour. */
  stops: [offset: number, color: string][];
  from: [number, number];
  to: [number, number];
  r0: number;
  r1: number;
  /** `[a, b, c, d, e, f]` taking a page-frame point to shading space. */
  toShading: [number, number, number, number, number, number];
}

/**
 * One thing a page paints besides text, as the printed page shows it: a fill,
 * a stroke (as the shape its outline covers), an image or a shading. It shows
 * only where every clip in force contains the point.
 */
export interface PdfPaint extends PdfShape {
  /**
   * `#rrggbb`; left out when the colour isn't one (an image, a shading, a
   * pattern), which counts as differing from every colour.
   */
  color?: string;
  /** Constant opacity, 0 to 1, inside its groups. */
  alpha: number;
  /**
   * The transparency groups it is drawn in, outermost first; left out when
   * none. A group's paints are composited together, then onto what is under
   * the group at the group's alpha.
   */
  groups?: PdfGroup[];
  /** A gradient giving its colour at each point; `color` is then left out. */
  shading?: PdfShading;
  /** The clipping paths in force, outermost first. */
  clips: PdfShape[];
  /** The bounds of `polygons` inside the clips' bounds, as a mark's box. */
  box: [number, number, number, number];
}

export interface PdfPage {
  /** MediaBox size in PDF points. */
  width: number;
  height: number;
  /** Text items with visible text (whitespace-only items left out), in content-stream order. */
  items: PdfTextItem[];
  /** What the page draws besides text, in content-stream order. */
  marks: PdfMark[];
  /** The same as paints with their geometry and colour, in content-stream order. */
  paints: PdfPaint[];
}

export interface PdfDocument {
  pages: PdfPage[];
}

// Chrome embeds each face as a subset, `ABCDEF+<PostScript name>`.
const subsetTag = /^[A-Z]{6}\+/;

interface TextContentItem {
  str: string;
  width: number;
  transform: number[];
  fontName: string;
}

/** Reads every page's size and text items (with positions and font names). */
export async function readPdf(pdf: Uint8Array): Promise<PdfDocument> {
  // A plain Uint8Array copy: pdf.js refuses Buffers (what puppeteer returns)
  // and may detach the array it is given. fontExtraProperties keeps each
  // font's name.
  const document = await getDocumentProxy(new Uint8Array(pdf), {
    fontExtraProperties: true,
  });
  const { OPS } = await getResolvedPDFJS();
  try {
    const pages: PdfPage[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const [left = 0, , right = 0, top = 0] = page.view;
      const bottom = page.view[1] ?? 0;
      const content = await page.getTextContent();
      // Fonts are resolved into commonObjs only once the page's operators
      // have been read.
      const operators = await page.getOperatorList();
      const fontNames = new Map<string, string>();
      const fontOf = (id: string) => {
        let name = fontNames.get(id);
        if (name === undefined) {
          let font: { name?: unknown } | undefined;
          try {
            font = page.commonObjs.get(id) as { name?: unknown } | undefined;
          } catch {
            font = undefined;
          }
          name =
            typeof font?.name === 'string'
              ? font.name.replace(subsetTag, '')
              : id;
          fontNames.set(id, name);
        }
        return name;
      };
      const items: PdfTextItem[] = [];
      for (const item of content.items as TextContentItem[]) {
        if (typeof item.str !== 'string' || item.str.trim() === '') continue;
        const [a = 0, b = 0, , d = 0, e = 0, f = 0] = item.transform;
        const length = Math.hypot(a, b);
        // Horizontal text runs left to right with no vertical component.
        const rotated = length > 0 && (Math.abs(b) > 1e-6 * length || a < 0);
        items.push({
          text: item.str,
          x0: e - left,
          x1: e - left + item.width,
          baseline: top - f,
          // The length of the text's vertical axis: the font size, also for
          // skewed (italic) or rotated text.
          size: Math.hypot(b, d),
          font: fontOf(item.fontName),
          // PDF space is y up; the page frame is y down.
          ...(rotated ? { dir: [a / length, -b / length] } : {}),
        });
      }
      // Shading patterns are resolved into the page's objects once its
      // operators have been read.
      const objectOf = (id: string): unknown => {
        for (const objects of [page.objs, page.commonObjs]) {
          try {
            if (objects.has(id)) return objects.get(id);
          } catch {}
        }
        return undefined;
      };
      const { marks, paints } = readMarks(
        operators,
        OPS,
        [left, bottom, right, top],
        objectOf,
      );
      pages.push({
        width: right - left,
        height: top - bottom,
        items,
        marks,
        paints,
      });
      page.cleanup();
    }
    return { pages };
  } finally {
    await document.loadingTask.destroy();
  }
}

type Matrix = [number, number, number, number, number, number];
/** `[x0, y0, x1, y1]` in PDF user space (y up). */
type Rect = [number, number, number, number];

const identity: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The axis-aligned bounds of `rect` mapped through `m`. */
function mapRect(m: Matrix, [x0, y0, x1, y1]: Rect): Rect {
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

const intersect = (a: Rect, b: Rect): Rect => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];

const asMatrix = (value: unknown): Matrix | undefined =>
  Array.isArray(value) &&
  value.length === 6 &&
  value.every(n => typeof n === 'number')
    ? (value as Matrix)
    : undefined;

const asRect = (value: unknown): Rect | undefined => {
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

interface GraphicsState {
  ctm: Matrix;
  clip: Rect;
  lineWidth: number;
  /** Constant alpha of fills (and images) and of strokes: 0 paints nothing. */
  fillAlpha: number;
  strokeAlpha: number;
  /** The transparency groups painting this, outermost first. */
  groups: PdfGroup[];
  /** The space of the page or form XObject being painted: patterns' parent. */
  base: Matrix;
  /** The clipping paths in force, in the page frame. */
  clips: PdfShape[];
  fill: Paint;
  stroke: Paint;
}

/**
 * `#rrggbb`; a gradient, as pdf.js's shading IR and the matrix from its
 * space to PDF space; undefined: no colour (a tiling pattern); null: paints
 * nothing.
 */
type Paint = string | { ir: unknown; matrix: Matrix } | undefined | null;

const invert = ([a, b, c, d, e, f]: Matrix): Matrix | undefined => {
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

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every(n => typeof n === 'number' && Number.isFinite(n));

/**
 * A gradient from pdf.js's shading IR (`["RadialAxial", "axial" | "radial",
 * bbox, stops, p0, p1, r0, r1]`); `toPage` takes its space to the page frame.
 * Any other shading: undefined.
 */
function shadingOf(ir: unknown, toPage: Matrix): PdfShading | undefined {
  if (!Array.isArray(ir) || ir[0] !== 'RadialAxial') return undefined;
  const [, kind, , stops, from, to, r0, r1] = ir as unknown[];
  const toShading = invert(toPage);
  if (
    (kind !== 'axial' && kind !== 'radial') ||
    !Array.isArray(stops) ||
    stops.length === 0 ||
    !stops.every(
      stop =>
        Array.isArray(stop) &&
        typeof stop[0] === 'number' &&
        typeof stop[1] === 'string' &&
        /^#[0-9a-f]{6}$/i.test(stop[1]),
    ) ||
    !isPoint(from) ||
    !isPoint(to) ||
    !toShading
  ) {
    return undefined;
  }
  const radius = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    kind,
    stops: (stops as [number, string][]).map(([offset, color]) => [
      offset,
      color.toLowerCase(),
    ]),
    from,
    to,
    r0: radius(r0),
    r1: radius(r1),
    toShading,
  };
}

/** A subpath in user space: `[x0, y0, x1, y1, …]`. */
interface Subpath {
  points: number[];
  closed: boolean;
}

/** Segments a curve is flattened into: 0.06 pt off a 50 pt circle's arc. */
const curveSegments = 16;

/**
 * The subpaths of pdf.js 6's path data (`DrawOPS`: moveTo 0, lineTo 1,
 * curveTo 2, quadraticCurveTo 3, closePath 4), curves flattened.
 */
function subpathsOf(value: unknown): Subpath[] {
  const raw = Array.isArray(value) ? value[0] : value;
  const data = ArrayBuffer.isView(raw)
    ? Array.from(raw as Float32Array)
    : Array.isArray(raw)
      ? (raw as number[])
      : [];
  const subpaths: Subpath[] = [];
  let current: Subpath | undefined;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const at = (i: number) => data[i] ?? 0;
  const open = () => {
    if (!current) {
      current = { points: [x, y], closed: false };
      subpaths.push(current);
    }
    return current;
  };
  const curve = (point: (t: number) => [number, number]) => {
    const path = open();
    for (let k = 1; k <= curveSegments; k++) {
      [x, y] = point(k / curveSegments);
      path.points.push(x, y);
    }
  };
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    if (op === 0) {
      x = startX = at(i++);
      y = startY = at(i++);
      current = undefined;
      open();
    } else if (op === 1) {
      const path = open();
      x = at(i++);
      y = at(i++);
      path.points.push(x, y);
    } else if (op === 2) {
      const [ax, ay, bx, by, cx, cy] = [0, 1, 2, 3, 4, 5].map(k => at(i + k));
      i += 6;
      const [px, py] = [x, y];
      curve(t => {
        const u = 1 - t;
        return [
          u * u * u * px +
            3 * u * u * t * (ax ?? 0) +
            3 * u * t * t * (bx ?? 0) +
            t * t * t * (cx ?? 0),
          u * u * u * py +
            3 * u * u * t * (ay ?? 0) +
            3 * u * t * t * (by ?? 0) +
            t * t * t * (cy ?? 0),
        ];
      });
    } else if (op === 3) {
      const [ax, ay, cx, cy] = [0, 1, 2, 3].map(k => at(i + k));
      i += 4;
      const [px, py] = [x, y];
      curve(t => {
        const u = 1 - t;
        return [
          u * u * px + 2 * u * t * (ax ?? 0) + t * t * (cx ?? 0),
          u * u * py + 2 * u * t * (ay ?? 0) + t * t * (cy ?? 0),
        ];
      });
    } else if (op === 4) {
      if (current) current.closed = true;
      current = undefined;
      x = startX;
      y = startY;
    } else break;
  }
  return subpaths;
}

/** Twice the signed area of a flat point list. */
function signedArea(points: number[]): number {
  let area = 0;
  const n = points.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area +=
      (points[2 * i] ?? 0) * (points[2 * j + 1] ?? 0) -
      (points[2 * j] ?? 0) * (points[2 * i + 1] ?? 0);
  }
  return area;
}

/**
 * The region a stroke of `width` along the subpaths covers, in user space:
 * one quad per segment and an octagon per vertex (round joins), all wound
 * the same way so that the nonzero rule unites them. Dashes are drawn solid.
 */
function strokeOutline(subpaths: Subpath[], width: number): number[][] {
  const half = width / 2;
  const polygons: number[][] = [];
  const add = (points: number[]) => {
    if (signedArea(points) < 0) {
      const reversed: number[] = [];
      for (let k = points.length - 2; k >= 0; k -= 2) {
        reversed.push(points[k] ?? 0, points[k + 1] ?? 0);
      }
      polygons.push(reversed);
    } else polygons.push(points);
  };
  for (const { points, closed } of subpaths) {
    const n = points.length >> 1;
    const segments = closed ? n : n - 1;
    for (let i = 0; i < n; i++) {
      const px = points[2 * i] ?? 0;
      const py = points[2 * i + 1] ?? 0;
      // An open subpath's ends are butt caps, not joins.
      if (closed || (i > 0 && i < n - 1)) {
        const join: number[] = [];
        for (let k = 0; k < 8; k++) {
          const angle = (k * Math.PI) / 4;
          join.push(px + half * Math.cos(angle), py + half * Math.sin(angle));
        }
        add(join);
      }
      if (i >= segments) continue;
      const j = (i + 1) % n;
      const qx = points[2 * j] ?? 0;
      const qy = points[2 * j + 1] ?? 0;
      const length = Math.hypot(qx - px, qy - py);
      if (length === 0) continue;
      const nx = (-(qy - py) / length) * half;
      const ny = ((qx - px) / length) * half;
      add([
        px + nx,
        py + ny,
        qx + nx,
        qy + ny,
        qx - nx,
        qy - ny,
        px - nx,
        py - ny,
      ]);
    }
  }
  return polygons;
}

/**
 * The boxes of the images, paths and clips in a page's operator list
 * (pdf.js 6: `constructPath` carries its paint operator and its bounds).
 * `view` is the MediaBox; boxes come out in the text items' frame.
 */
function readMarks(
  operators: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  view: Rect,
  objectOf: (id: string) => unknown,
): { marks: PdfMark[]; paints: PdfPaint[] } {
  const [left, , , top] = view;
  // PDF space (y up) to the page frame (y down, from the MediaBox's corner).
  const frame: Matrix = [1, 0, 0, -1, -left, top];
  let groupCount = 0;
  const filled = new Set(
    [
      'fill',
      'eoFill',
      'fillStroke',
      'eoFillStroke',
      'closeFillStroke',
      'closeEOFillStroke',
    ].map(name => OPS[name]),
  );
  const stroked = new Set(
    [
      'stroke',
      'closeStroke',
      'fillStroke',
      'eoFillStroke',
      'closeFillStroke',
      'closeEOFillStroke',
    ].map(name => OPS[name]),
  );
  const images = new Set(
    [
      'paintImageXObject',
      'paintInlineImageXObject',
      'paintImageMaskXObject',
      'paintSolidColorImageMask',
    ].map(name => OPS[name]),
  );
  const evenOdd = new Set(
    ['eoFill', 'eoFillStroke', 'closeEOFillStroke'].map(name => OPS[name]),
  );
  const closing = new Set(
    ['closeStroke', 'closeFillStroke', 'closeEOFillStroke'].map(
      name => OPS[name],
    ),
  );
  const marks: PdfMark[] = [];
  const paints: PdfPaint[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = {
    ctm: identity,
    clip: view,
    lineWidth: 1,
    fillAlpha: 1,
    strokeAlpha: 1,
    groups: [],
    base: identity,
    clips: [],
    fill: '#000000',
    stroke: '#000000',
  };
  let clipping: PdfShape['rule'] | undefined;
  /** User-space points through the CTM into the page frame. */
  const toPage = (points: number[]) => {
    const [a, b, c, d, e, f] = state.ctm;
    const out: number[] = [];
    for (let k = 0; k < points.length; k += 2) {
      const x = points[k] ?? 0;
      const y = points[k + 1] ?? 0;
      out.push(a * x + c * y + e - left, top - (b * x + d * y + f));
    }
    return out;
  };
  const rectPolygon = ([x0, y0, x1, y1]: Rect) => [
    x0 - left,
    top - y0,
    x1 - left,
    top - y0,
    x1 - left,
    top - y1,
    x0 - left,
    top - y1,
  ];
  /** Records a paint over `polygons` (page frame), if it shows. */
  const paint = (
    polygons: number[][],
    rule: PdfShape['rule'],
    color: Paint,
    alpha: number,
  ) => {
    if (color === null || alpha <= 0 || polygons.length === 0) return;
    const shading =
      typeof color === 'object'
        ? shadingOf(color.ir, multiply(frame, color.matrix))
        : undefined;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const points of polygons) {
      for (let k = 0; k < points.length; k += 2) {
        const x = points[k] ?? 0;
        const y = points[k + 1] ?? 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    // The clip's rect is in PDF space (y up), the polygons in the page frame.
    const [x0, y0, x1, y1] = intersect(
      [minX + left, top - maxY, maxX + left, top - minY],
      state.clip,
    );
    if (!(x0 <= x1 && y0 <= y1)) return;
    paints.push({
      polygons,
      rule,
      ...(typeof color === 'string' ? { color } : {}),
      ...(shading ? { shading } : {}),
      alpha,
      ...(state.groups.length > 0 ? { groups: state.groups } : {}),
      clips: state.clips,
      box: [x0 - left, top - y1, x1 - left, top - y0],
    });
  };
  const colorOf = (args: unknown[]) =>
    typeof args[0] === 'string' && /^#[0-9a-f]{6}$/i.test(args[0])
      ? args[0].toLowerCase()
      : undefined;
  /** A shading pattern (`["Shading", id, matrix]`); a tiling one: undefined. */
  const patternOf = (args: unknown[]): Paint => {
    if (args[0] !== 'Shading' || typeof args[1] !== 'string') return undefined;
    const ir = objectOf(args[1]);
    return ir === undefined
      ? undefined
      : { ir, matrix: multiply(state.base, asMatrix(args[2]) ?? identity) };
  };
  const push = () => stack.push({ ...state });
  const pop = () => {
    state = stack.pop() ?? state;
  };
  const mark = (kind: PdfMark['kind'], rect: Rect) => {
    const [x0, y0, x1, y1] = intersect(rect, state.clip);
    if (x0 > x1 || y0 > y1) return;
    marks.push({ kind, box: [x0 - left, top - y1, x1 - left, top - y0] });
  };
  operators.fnArray.forEach((fn, i) => {
    const args = (operators.argsArray[i] ?? []) as unknown[];
    if (fn === OPS.save) push();
    else if (fn === OPS.restore) pop();
    else if (fn === OPS.transform) {
      const m = asMatrix(args);
      if (m) state.ctm = multiply(state.ctm, m);
    } else if (fn === OPS.setLineWidth) {
      if (typeof args[0] === 'number') state.lineWidth = args[0];
    } else if (fn === OPS.setGState) {
      for (const entry of (args[0] ?? []) as unknown[]) {
        if (!Array.isArray(entry) || typeof entry[1] !== 'number') continue;
        if (entry[0] === 'LW') state.lineWidth = entry[1];
        else if (entry[0] === 'ca') state.fillAlpha = entry[1];
        else if (entry[0] === 'CA') state.strokeAlpha = entry[1];
      }
    } else if (fn === OPS.setFillRGBColor) state.fill = colorOf(args);
    else if (fn === OPS.setStrokeRGBColor) state.stroke = colorOf(args);
    else if (fn === OPS.setFillColorN) state.fill = patternOf(args);
    else if (fn === OPS.setStrokeColorN) state.stroke = patternOf(args);
    else if (fn === OPS.setFillTransparent) state.fill = null;
    else if (fn === OPS.setStrokeTransparent) state.stroke = null;
    else if (fn === OPS.clip) clipping = 'nonzero';
    else if (fn === OPS.eoClip) clipping = 'evenodd';
    else if (fn === OPS.constructPath) {
      const bounds = asRect(args[2]);
      const op = args[0] as number;
      if (bounds) {
        const rect = mapRect(state.ctm, bounds);
        // Only paint at some opacity is a mark.
        const stroke = stroked.has(op) && state.strokeAlpha > 0;
        const fill = filled.has(op) && state.fillAlpha > 0;
        const subpaths = subpathsOf(args[1]);
        if (closing.has(op)) {
          const last = subpaths[subpaths.length - 1];
          if (last) last.closed = true;
        }
        const area = () => subpaths.map(({ points }) => toPage(points));
        if (fill) {
          paint(
            area(),
            evenOdd.has(op) ? 'evenodd' : 'nonzero',
            state.fill,
            state.fillAlpha,
          );
        }
        if (stroke || fill) {
          // A stroke reaches half its width beyond the path: on each axis,
          // as far as the CTM stretches a circle of that radius.
          const [a, b, c, d] = state.ctm;
          const half = stroke ? state.lineWidth / 2 : 0;
          const hx = half * Math.hypot(a, c);
          const hy = half * Math.hypot(b, d);
          const reach: Rect = [
            rect[0] - hx,
            rect[1] - hy,
            rect[2] + hx,
            rect[3] + hy,
          ];
          mark('path', reach);
          if (stroke) {
            paint(
              strokeOutline(subpaths, state.lineWidth).map(toPage),
              'nonzero',
              state.stroke,
              state.strokeAlpha,
            );
          }
        }
        if (clipping) {
          mark('clip', rect);
          state.clip = intersect(state.clip, rect);
          state.clips = [...state.clips, { polygons: area(), rule: clipping }];
        }
      }
      clipping = undefined;
    } else if (images.has(fn)) {
      if (state.fillAlpha > 0) {
        const rect = mapRect(state.ctm, [0, 0, 1, 1]);
        mark('image', rect);
        paint(
          [toPage([0, 0, 1, 0, 1, 1, 0, 1])],
          'nonzero',
          undefined,
          state.fillAlpha,
        );
      }
    } else if (fn === OPS.shadingFill) {
      mark('path', state.clip);
      // Its shading (an id or the IR itself) in the current user space.
      const ir = typeof args[0] === 'string' ? objectOf(args[0]) : args[0];
      paint(
        [rectPolygon(state.clip)],
        'nonzero',
        { ir, matrix: state.ctm },
        state.fillAlpha,
      );
    } else if (fn === OPS.paintFormXObjectBegin || fn === OPS.beginGroup) {
      push();
      if (fn === OPS.beginGroup) {
        // A transparency group is composited, then painted at the alpha in
        // force when it starts, which inside it starts again at 1.
        state.groups = [
          ...state.groups,
          { id: groupCount++, alpha: state.fillAlpha },
        ];
        state.fillAlpha = 1;
        state.strokeAlpha = 1;
      }
      const group = args[0] as { matrix?: unknown; bbox?: unknown } | undefined;
      const m =
        fn === OPS.paintFormXObjectBegin
          ? asMatrix(args[0])
          : asMatrix(group?.matrix);
      if (m) state.ctm = multiply(state.ctm, m);
      if (fn === OPS.paintFormXObjectBegin) state.base = state.ctm;
      const bbox = asRect(
        fn === OPS.paintFormXObjectBegin ? args[1] : group?.bbox,
      );
      if (bbox) {
        const rect = mapRect(state.ctm, bbox);
        state.clip = intersect(state.clip, rect);
        const [x0, y0, x1, y1] = bbox;
        state.clips = [
          ...state.clips,
          {
            polygons: [toPage([x0, y0, x1, y0, x1, y1, x0, y1])],
            rule: 'nonzero',
          },
        ];
      }
    } else if (fn === OPS.paintFormXObjectEnd || fn === OPS.endGroup) pop();
  });
  return { marks, paints };
}
