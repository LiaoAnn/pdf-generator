import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import {
  asMatrix,
  asRect,
  identity,
  intersect,
  type Matrix,
  mapRect,
  multiply,
  type Rect,
} from './geometry.ts';
import {
  type ImagePixels,
  maxPaintPoints,
  maxPaints,
  readPaints,
} from './paints.ts';

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
  /**
   * The soft mask in force when the group is painted: it applies to the
   * composited group, once, not to each of its paints (inside the group no
   * mask is in force until one is set there).
   */
  mask?: PdfMask;
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
  toShading: PdfMatrix;
}

/** `[a, b, c, d, e, f]`: (x, y) to (a x + c y + e, b x + d y + f). */
export type PdfMatrix = [number, number, number, number, number, number];

/**
 * A free-form gradient as triangles (PDF shading types 4 to 7, as pdf.js
 * splits them): the colour at a point is the colour of the last triangle
 * containing it, interpolated between its corners; outside every triangle,
 * the point isn't painted.
 */
export interface PdfMesh {
  /** x, y per vertex in shading space, 3 vertices a triangle. */
  positions: Float32Array;
  /** R, G, B and an unused byte per vertex. */
  colors: Uint8Array;
  /** Vertices: 3 per triangle. */
  count: number;
  toShading: PdfMatrix;
}

/**
 * A soft mask: what a paint shows is multiplied, at each point, by the
 * mask's paints composited there (in the same frame): their luminosity over
 * `backdrop` when `luminosity`, else their alpha.
 */
export interface PdfMask {
  paints: PdfPaint[];
  luminosity: boolean;
  backdrop: string;
  /**
   * The mask's transfer function as 256 bytes: a mask value v (0 to 1)
   * becomes `transfer[round(v * 255)] / 255`; left out: unchanged.
   */
  transfer?: number[];
}

/** A decoded raster image. */
export interface PdfImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes a pixel, row 0 at the image's top. */
  rgba: Uint8Array;
  /**
   * Page frame to image space, the unit square: the pixel at (u, v) is
   * column floor(u * width), row floor((1 - v) * height); outside it, none.
   */
  toImage: PdfMatrix;
}

/**
 * A tiling pattern: its tile's paints repeat every `step` in pattern space.
 * The colour at a page point is that of the tile's paints at the point
 * `toPattern` takes it to, moved by whole steps into `[bbox x0, x0 + step x)`
 * and `[bbox y0, y0 + step y)`; where no tile paint shows, nothing is painted.
 */
export interface PdfTile {
  /** In pattern space (y up), as page paints are in the page frame. */
  paints: PdfPaint[];
  bbox: [number, number, number, number];
  step: [number, number];
  toPattern: PdfMatrix;
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
  /** A mesh gradient giving its colour at each point. */
  mesh?: PdfMesh;
  /** The soft mask in force. */
  mask?: PdfMask;
  /** A raster image giving its colour and alpha at each point. */
  image?: PdfImage;
  /** A tiling pattern (an SVG `<pattern>`, a CSS background image or repeating gradient) giving its colour and alpha at each point. */
  tile?: PdfTile;
  /**
   * Its colour can't be measured (an image over the decoding budget, an
   * image mask, another kind of shading or pattern): it adds no ink and
   * hides the ink under it.
   */
  unmeasured?: true;
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
  // font's name; images come as decoded pixels, not bitmaps.
  const document = await getDocumentProxy(new Uint8Array(pdf), {
    fontExtraProperties: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  const { OPS } = await getResolvedPDFJS();
  // Decoded pixels stay with the pages' paints: one budget for the document,
  // and an image used again (the same PDF object) is decoded once.
  let budget = maxPixels;
  // Polygon points the document's paints may keep, across its pages.
  const pointBudget = { left: maxPaintPoints };
  const paintBudget = { left: maxPaints, dropped: 0 };
  const byRef = new Map<string, ImagePixels | undefined>();
  const decode = (image: unknown) => {
    const ref = (image as { ref?: unknown } | undefined)?.ref;
    if (typeof ref === 'string' && byRef.has(ref)) return byRef.get(ref);
    const pixels = decodeImage(image, budget);
    if (pixels) budget -= pixels.width * pixels.height;
    if (typeof ref === 'string') byRef.set(ref, pixels);
    return pixels;
  };
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
      const marks = readMarks(operators, OPS, [left, bottom, right, top]);
      const objectOf = (id: string): unknown => {
        const objects = id.startsWith('g_') ? page.commonObjs : page.objs;
        return objects.has(id) ? objects.get(id) : undefined;
      };
      const images = await pageImages(operators, OPS, page);
      const decoded = new Map<string, ImagePixels | undefined>();
      paintBudget.dropped = 0;
      const paints = readPaints(operators, OPS, {
        frame: [1, 0, 0, -1, -left, top],
        clip: [left, bottom, right, top],
        pointBudget,
        paintBudget,
        sources: {
          objectOf,
          imageOf: id => {
            if (!decoded.has(id)) decoded.set(id, decode(images.get(id)));
            return decoded.get(id);
          },
          decode,
        },
      });
      if (paintBudget.dropped > 0) {
        // Paints were dropped: nothing on this page can be measured.
        const [width, height] = [right - left, top - bottom];
        paints.push({
          polygons: [[0, 0, width, 0, width, height, 0, height]],
          rule: 'nonzero',
          unmeasured: true,
          alpha: 1,
          clips: [],
          box: [0, 0, width, height],
        });
      }
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

/**
 * The most image pixels decoded per document (16 MB of RGBA): images past
 * it aren't measured, so the blocks they alone draw are refused, not passed.
 */
const maxPixels = 1 << 22;

/**
 * The image XObjects a page's operators paint, also inside tiling patterns,
 * by id, once pdf.js has resolved them.
 */
async function pageImages(
  operators: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  page: {
    objs: { get(id: string, callback: (value: unknown) => void): unknown };
    commonObjs: {
      get(id: string, callback: (value: unknown) => void): unknown;
    };
  },
): Promise<Map<string, unknown>> {
  const ids = new Set<string>();
  const scan = (list: { fnArray: number[]; argsArray: unknown[] }) => {
    list.fnArray.forEach((fn, i) => {
      const args = (list.argsArray[i] ?? []) as unknown[];
      if (fn === OPS.paintImageXObject && typeof args[0] === 'string') {
        ids.add(args[0]);
      } else if (
        (fn === OPS.setFillColorN || fn === OPS.setStrokeColorN) &&
        args[0] === 'TilingPattern'
      ) {
        const inner = args[2] as { fnArray?: unknown; argsArray?: unknown };
        if (Array.isArray(inner?.fnArray) && Array.isArray(inner.argsArray)) {
          scan({ fnArray: inner.fnArray, argsArray: inner.argsArray });
        }
      }
    });
  };
  scan(operators);
  const images = new Map<string, unknown>();
  await Promise.all(
    [...ids].map(
      id =>
        new Promise<void>(resolve => {
          const objects = id.startsWith('g_') ? page.commonObjs : page.objs;
          objects.get(id, value => {
            images.set(id, value);
            resolve();
          });
        }),
    ),
  );
  return images;
}

/**
 * pdf.js's decoded image (`kind` 1: 1 bit grey, 2: RGB, 3: RGBA; rows top
 * first) as RGBA, if it has at most `budget` pixels.
 */
function decodeImage(image: unknown, budget: number): ImagePixels | undefined {
  const { width, height, kind, data } = (image ?? {}) as {
    width?: unknown;
    height?: unknown;
    kind?: unknown;
    data?: unknown;
  };
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !(width > 0 && height > 0) ||
    width * height > budget ||
    !(data instanceof Uint8ClampedArray || data instanceof Uint8Array)
  ) {
    return undefined;
  }
  const rgba = new Uint8Array(width * height * 4);
  if (kind === 3 && data.length >= rgba.length)
    rgba.set(data.subarray(0, rgba.length));
  else if (kind === 2 && data.length >= width * height * 3) {
    for (let p = 0; p < width * height; p++) {
      rgba[4 * p] = data[3 * p] ?? 0;
      rgba[4 * p + 1] = data[3 * p + 1] ?? 0;
      rgba[4 * p + 2] = data[3 * p + 2] ?? 0;
      rgba[4 * p + 3] = 255;
    }
  } else if (kind === 1) {
    // A set bit is white, as pdf.js draws it.
    const row = Math.ceil(width / 8);
    if (data.length < row * height) return undefined;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = ((data[y * row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        rgba.fill(bit ? 255 : 0, 4 * (y * width + x), 4 * (y * width + x) + 3);
        rgba[4 * (y * width + x) + 3] = 255;
      }
    }
  } else return undefined;
  // A transparent pixel's colour is meaningless; pdf.js leaves some there.
  for (let p = 3; p < rgba.length; p += 4) {
    if (rgba[p] === 0) rgba.fill(0, p - 3, p);
  }
  return { width, height, rgba };
}

interface GraphicsState {
  ctm: Matrix;
  clip: Rect;
  lineWidth: number;
  /** Constant alpha of fills (and images) and of strokes: 0 paints nothing. */
  fillAlpha: number;
  strokeAlpha: number;
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
): PdfMark[] {
  const [left, , , top] = view;
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
  const marks: PdfMark[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = {
    ctm: identity,
    clip: view,
    lineWidth: 1,
    fillAlpha: 1,
    strokeAlpha: 1,
  };
  let clipping = false;
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
    } else if (fn === OPS.clip || fn === OPS.eoClip) clipping = true;
    else if (fn === OPS.constructPath) {
      const bounds = asRect(args[2]);
      const op = args[0] as number;
      if (bounds) {
        const rect = mapRect(state.ctm, bounds);
        // Only paint at some opacity is a mark.
        const stroke = stroked.has(op) && state.strokeAlpha > 0;
        const fill = filled.has(op) && state.fillAlpha > 0;
        if (stroke || fill) {
          // A stroke reaches half its width beyond the path: on each axis,
          // as far as the CTM stretches a circle of that radius.
          const [a, b, c, d] = state.ctm;
          const half = stroke ? state.lineWidth / 2 : 0;
          const hx = half * Math.hypot(a, c);
          const hy = half * Math.hypot(b, d);
          mark('path', [
            rect[0] - hx,
            rect[1] - hy,
            rect[2] + hx,
            rect[3] + hy,
          ]);
        }
        if (clipping) {
          mark('clip', rect);
          state.clip = intersect(state.clip, rect);
        }
      }
      clipping = false;
    } else if (images.has(fn)) {
      if (state.fillAlpha > 0) mark('image', mapRect(state.ctm, [0, 0, 1, 1]));
    } else if (fn === OPS.shadingFill) mark('path', state.clip);
    else if (fn === OPS.paintFormXObjectBegin || fn === OPS.beginGroup) {
      push();
      const group = args[0] as { matrix?: unknown; bbox?: unknown } | undefined;
      const m =
        fn === OPS.paintFormXObjectBegin
          ? asMatrix(args[0])
          : asMatrix(group?.matrix);
      if (m) state.ctm = multiply(state.ctm, m);
      const bbox = asRect(
        fn === OPS.paintFormXObjectBegin ? args[1] : group?.bbox,
      );
      if (bbox) state.clip = intersect(state.clip, mapRect(state.ctm, bbox));
    } else if (fn === OPS.paintFormXObjectEnd || fn === OPS.endGroup) pop();
  });
  return marks;
}
