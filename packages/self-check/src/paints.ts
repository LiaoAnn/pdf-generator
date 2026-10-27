// Reads what a page paints besides text, with its geometry and colour, from
// pdf.js's operator list (T14-9): fills, strokes, images, gradients, meshes,
// tiling patterns, transparency groups and soft masks.
import {
  asMatrix,
  asRect,
  identity,
  intersect,
  invert,
  type Matrix,
  mapRect,
  multiply,
  type Rect,
} from './geometry.ts';
import type {
  PdfGroup,
  PdfImage,
  PdfMask,
  PdfPaint,
  PdfShape,
  PdfTile,
} from './pdf.ts';

/** A decoded image's pixels; its placement comes from where it is painted. */
export type ImagePixels = Omit<PdfImage, 'toImage'>;

interface PaintSources {
  /** A shading's or pattern's IR by id (`pattern_p0_1`). */
  objectOf: (id: string) => unknown;
  /** An image's pixels by id; none: not decoded (over the budget, a mask). */
  imageOf: (id: string) => ImagePixels | undefined;
  /** An inline image's pixels; none: not decoded. */
  decode: (image: unknown) => ImagePixels | undefined;
}

/** The most paints a tile may hold, and the most mesh vertices, to be measured. */
const maxTilePaints = 256;
const maxMeshVertices = 1 << 20;

/**
 * What paints with: `#rrggbb`; a shading's IR and the matrix from its space
 * to PDF space; a tiling pattern; undefined: can't be measured; null:
 * paints nothing.
 */
type Source =
  | string
  | { ir: unknown; matrix: Matrix }
  | { tile: PdfTile }
  | undefined
  | null;

interface GraphicsState {
  ctm: Matrix;
  /** The clip's bounds, in the space `frame` maps from. */
  clip: Rect;
  lineWidth: number;
  fillAlpha: number;
  strokeAlpha: number;
  groups: PdfGroup[];
  /** The soft mask in force. */
  mask: PdfMask | undefined;
  /** The space of the page, form XObject or tile being painted: patterns' parent. */
  base: Matrix;
  /** The clipping paths in force, in the output frame. */
  clips: PdfShape[];
  fill: Source;
  stroke: Source;
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

/** A shading's colour source from pdf.js's IR; `toFrame` takes its space to the output frame. */
function shadingOf(
  ir: unknown,
  toFrame: Matrix,
): Pick<PdfPaint, 'shading' | 'mesh'> | undefined {
  const toShading = invert(toFrame);
  if (!Array.isArray(ir) || !toShading) return undefined;
  if (ir[0] === 'Mesh') {
    // ["Mesh", type, positions (x, y a vertex, 3 vertices a triangle),
    // colours (4 bytes a vertex), vertex count, …]
    const [, , positions, colors, count] = ir as unknown[];
    if (
      !(positions instanceof Float32Array) ||
      !(colors instanceof Uint8Array) ||
      typeof count !== 'number' ||
      count > maxMeshVertices ||
      positions.length < count * 2 ||
      colors.length < count * 4
    ) {
      return undefined;
    }
    return { mesh: { positions, colors, count, toShading } };
  }
  if (ir[0] !== 'RadialAxial') return undefined;
  const [, kind, , stops, from, to, r0, r1] = ir as unknown[];
  const isPoint = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(n => typeof n === 'number' && Number.isFinite(n));
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
    !isPoint(to)
  ) {
    return undefined;
  }
  const radius = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    shading: {
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
    },
  };
}

export interface PaintOptions {
  /** PDF space (y up) to the output frame. */
  frame: Matrix;
  /** The clip the content starts with, in PDF space (the MediaBox, a tile's bbox). */
  clip: Rect;
  sources: PaintSources;
  /** Tiling patterns inside this many others can't be measured. */
  depth?: number;
}

/**
 * The paints of an operator list (pdf.js 6: `constructPath` carries its
 * paint operator and its bounds), in the output frame, in order.
 */
export function readPaints(
  operators: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  { frame, clip, sources, depth = 0 }: PaintOptions,
): PdfPaint[] {
  const ops = (...names: string[]) => new Set(names.map(name => OPS[name]));
  const filled = ops(
    'fill',
    'eoFill',
    'fillStroke',
    'eoFillStroke',
    'closeFillStroke',
    'closeEOFillStroke',
  );
  const stroked = ops(
    'stroke',
    'closeStroke',
    'fillStroke',
    'eoFillStroke',
    'closeFillStroke',
    'closeEOFillStroke',
  );
  const evenOdd = ops('eoFill', 'eoFillStroke', 'closeEOFillStroke');
  const closing = ops('closeStroke', 'closeFillStroke', 'closeEOFillStroke');
  // Paints go to the innermost target: the output, or a soft mask being drawn.
  const targets: PdfPaint[][] = [[]];
  const stack: GraphicsState[] = [];
  /** Per open group: the soft mask it draws, if it is one. */
  const groupKinds: ({ luminosity: boolean; backdrop: string } | undefined)[] =
    [];
  let pendingMask: PdfMask | undefined;
  let groupCount = 0;
  let state: GraphicsState = {
    ctm: identity,
    clip,
    lineWidth: 1,
    fillAlpha: 1,
    strokeAlpha: 1,
    groups: [],
    mask: undefined,
    base: identity,
    clips: [],
    fill: '#000000',
    stroke: '#000000',
  };
  let clipping: PdfShape['rule'] | undefined;
  /** User-space points through the CTM into the output frame. */
  const toFrame = (points: number[]) => {
    const [a, b, c, d, e, f] = multiply(frame, state.ctm);
    const out: number[] = [];
    for (let k = 0; k < points.length; k += 2) {
      const x = points[k] ?? 0;
      const y = points[k + 1] ?? 0;
      out.push(a * x + c * y + e, b * x + d * y + f);
    }
    return out;
  };
  /** Records a paint over `polygons` (output frame), if it shows. */
  const paint = (
    polygons: number[][],
    rule: PdfShape['rule'],
    source: Source | { image: PdfImage | undefined },
    alpha: number,
  ) => {
    if (source === null || alpha <= 0 || polygons.length === 0) return;
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
    const [x0, y0, x1, y1] = intersect(
      [minX, minY, maxX, maxY],
      mapRect(frame, state.clip),
    );
    if (!(x0 <= x1 && y0 <= y1)) return;
    let colour: Partial<PdfPaint> = { unmeasured: true };
    if (typeof source === 'string') colour = { color: source };
    else if (source && 'ir' in source) {
      colour = shadingOf(source.ir, multiply(frame, source.matrix)) ?? colour;
    } else if (source && 'tile' in source) colour = { tile: source.tile };
    else if (source && 'image' in source && source.image) {
      colour = { image: source.image };
    }
    targets[targets.length - 1]?.push({
      polygons,
      rule,
      ...colour,
      alpha,
      ...(state.groups.length > 0 ? { groups: state.groups } : {}),
      ...(state.mask ? { mask: state.mask } : {}),
      clips: state.clips,
      box: [x0, y0, x1, y1],
    });
  };
  const colorOf = (args: unknown[]) =>
    typeof args[0] === 'string' && /^#[0-9a-f]{6}$/i.test(args[0])
      ? args[0].toLowerCase()
      : undefined;
  /**
   * A shading pattern (`["Shading", id, matrix]`) or a tiling one
   * (`["TilingPattern", colour, operators, matrix, bbox, xstep, ystep,
   * paintType, …]`); uncoloured tiling patterns aren't measured.
   */
  const patternOf = (args: unknown[]): Source => {
    if (args[0] === 'Shading' && typeof args[1] === 'string') {
      const ir = sources.objectOf(args[1]);
      return ir === undefined
        ? undefined
        : { ir, matrix: multiply(state.base, asMatrix(args[2]) ?? identity) };
    }
    if (args[0] !== 'TilingPattern' || depth > 0 || args[7] !== 1) {
      return undefined;
    }
    const list = args[2] as { fnArray?: unknown; argsArray?: unknown };
    const bbox = asRect(args[4]);
    const step = [args[5], args[6]];
    const toPattern = invert(
      multiply(frame, multiply(state.base, asMatrix(args[3]) ?? identity)),
    );
    if (
      !Array.isArray(list?.fnArray) ||
      !Array.isArray(list.argsArray) ||
      !bbox ||
      !toPattern ||
      !step.every(n => typeof n === 'number' && n !== 0 && Number.isFinite(n))
    ) {
      return undefined;
    }
    const paints = readPaints(
      { fnArray: list.fnArray, argsArray: list.argsArray },
      OPS,
      { frame: identity, clip: bbox, sources, depth: depth + 1 },
    );
    // A tile is measured only if all of it is.
    if (paints.length > maxTilePaints || paints.some(p => p.unmeasured)) {
      return undefined;
    }
    return {
      tile: {
        paints,
        bbox,
        step: [Math.abs(step[0] as number), Math.abs(step[1] as number)],
        toPattern,
      },
    };
  };
  const push = () => stack.push({ ...state });
  const pop = () => {
    state = stack.pop() ?? state;
  };
  /** The image space of the current CTM, as `PdfImage.toImage` wants it. */
  const placed = (pixels: ImagePixels | undefined): PdfImage | undefined => {
    const toImage = invert(multiply(frame, state.ctm));
    return pixels && toImage ? { ...pixels, toImage } : undefined;
  };
  const unitSquare = () => [toFrame([0, 0, 1, 0, 1, 1, 0, 1])];
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
        if (!Array.isArray(entry)) continue;
        const [key, value] = entry as [unknown, unknown];
        if (key === 'SMask') state.mask = value ? pendingMask : undefined;
        if (typeof value !== 'number') continue;
        if (key === 'LW') state.lineWidth = value;
        else if (key === 'ca') state.fillAlpha = value;
        else if (key === 'CA') state.strokeAlpha = value;
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
        const subpaths = subpathsOf(args[1]);
        if (closing.has(op)) {
          const last = subpaths[subpaths.length - 1];
          if (last) last.closed = true;
        }
        const area = () => subpaths.map(({ points }) => toFrame(points));
        if (filled.has(op)) {
          paint(
            area(),
            evenOdd.has(op) ? 'evenodd' : 'nonzero',
            state.fill,
            state.fillAlpha,
          );
        }
        if (stroked.has(op)) {
          paint(
            strokeOutline(subpaths, state.lineWidth).map(toFrame),
            'nonzero',
            state.stroke,
            state.strokeAlpha,
          );
        }
        if (clipping) {
          state.clip = intersect(state.clip, rect);
          state.clips = [...state.clips, { polygons: area(), rule: clipping }];
        }
      }
      clipping = undefined;
    } else if (fn === OPS.paintImageXObject) {
      const id = typeof args[0] === 'string' ? args[0] : '';
      paint(
        unitSquare(),
        'nonzero',
        { image: placed(sources.imageOf(id)) },
        state.fillAlpha,
      );
    } else if (fn === OPS.paintInlineImageXObject) {
      paint(
        unitSquare(),
        'nonzero',
        { image: placed(sources.decode(args[0])) },
        state.fillAlpha,
      );
    } else if (
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintSolidColorImageMask
    ) {
      // A stencil painted in the fill colour: not measured.
      paint(unitSquare(), 'nonzero', undefined, state.fillAlpha);
    } else if (fn === OPS.shadingFill) {
      // Its shading (an id or the IR itself) in the current user space.
      const ir =
        typeof args[0] === 'string' ? sources.objectOf(args[0]) : args[0];
      const [x0, y0, x1, y1] = state.clip;
      const [a, b, c, d, e, f] = frame;
      const corner = (x: number, y: number) => [
        a * x + c * y + e,
        b * x + d * y + f,
      ];
      paint(
        [
          [
            ...corner(x0, y0),
            ...corner(x1, y0),
            ...corner(x1, y1),
            ...corner(x0, y1),
          ],
        ],
        'nonzero',
        { ir, matrix: state.ctm },
        state.fillAlpha,
      );
    } else if (fn === OPS.paintFormXObjectBegin || fn === OPS.beginGroup) {
      push();
      const group = args[0] as
        | {
            matrix?: unknown;
            bbox?: unknown;
            smask?: { subtype?: unknown; backdrop?: unknown };
          }
        | undefined;
      if (fn === OPS.beginGroup) {
        if (group?.smask) {
          // Its content draws a soft mask, for a later `SMask` to use.
          const backdrop = colorOf([group.smask.backdrop]) ?? '#000000';
          groupKinds.push({
            luminosity: group.smask.subtype === 'Luminosity',
            backdrop,
          });
          targets.push([]);
          state.groups = [];
          state.mask = undefined;
        } else {
          // A transparency group is composited, then painted at the alpha
          // in force when it starts, which inside it starts again at 1.
          groupKinds.push(undefined);
          state.groups = [
            ...state.groups,
            { id: groupCount++, alpha: state.fillAlpha },
          ];
        }
        state.fillAlpha = 1;
        state.strokeAlpha = 1;
      }
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
        state.clip = intersect(state.clip, mapRect(state.ctm, bbox));
        const [x0, y0, x1, y1] = bbox;
        state.clips = [
          ...state.clips,
          {
            polygons: [toFrame([x0, y0, x1, y0, x1, y1, x0, y1])],
            rule: 'nonzero',
          },
        ];
      }
    } else if (fn === OPS.paintFormXObjectEnd) pop();
    else if (fn === OPS.endGroup) {
      const kind = groupKinds.pop();
      if (kind) pendingMask = { paints: targets.pop() ?? [], ...kind };
      pop();
    }
  });
  return targets[0] ?? [];
}
