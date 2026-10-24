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
  font: string;
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

export interface PdfPage {
  /** MediaBox size in PDF points. */
  width: number;
  height: number;
  /** Text items with visible text (whitespace-only items left out), in content-stream order. */
  items: PdfTextItem[];
  /** What the page draws besides text, in content-stream order. */
  marks: PdfMark[];
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
        const [, b = 0, , d = 0, e = 0, f = 0] = item.transform;
        items.push({
          text: item.str,
          x0: e - left,
          x1: e - left + item.width,
          baseline: top - f,
          // The length of the text's vertical axis: the font size, also for
          // skewed (italic) or rotated text.
          size: Math.hypot(b, d),
          font: fontOf(item.fontName),
        });
      }
      const marks = readMarks(operators, OPS, [left, bottom, right, top]);
      pages.push({ width: right - left, height: top - bottom, items, marks });
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
  const painted = new Set(
    [
      'stroke',
      'closeStroke',
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
  let state: GraphicsState = { ctm: identity, clip: view, lineWidth: 1 };
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
        if (Array.isArray(entry) && entry[0] === 'LW') {
          if (typeof entry[1] === 'number') state.lineWidth = entry[1];
        }
      }
    } else if (fn === OPS.clip || fn === OPS.eoClip) clipping = true;
    else if (fn === OPS.constructPath) {
      const bounds = asRect(args[2]);
      const op = args[0] as number;
      if (bounds) {
        const rect = mapRect(state.ctm, bounds);
        if (painted.has(op)) {
          // A stroke reaches half its width beyond the path, scaled by the CTM.
          const [a, b, c, d] = state.ctm;
          const half = stroked.has(op)
            ? (state.lineWidth * Math.sqrt(Math.abs(a * d - b * c))) / 2
            : 0;
          mark('path', [
            rect[0] - half,
            rect[1] - half,
            rect[2] + half,
            rect[3] + half,
          ]);
        }
        if (clipping) {
          mark('clip', rect);
          state.clip = intersect(state.clip, rect);
        }
      }
      clipping = false;
    } else if (images.has(fn)) mark('image', mapRect(state.ctm, [0, 0, 1, 1]));
    else if (fn === OPS.shadingFill) mark('path', state.clip);
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
