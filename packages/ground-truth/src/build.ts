import {
  type BlockType,
  blockTypes,
  type GroundTruth,
  gtSchema,
} from '@pdf-generator/contract';
import type {
  MeasuredElement,
  Measurement,
  PaintedBox,
  Rect,
  Region,
} from './measurement.ts';

type Bbox = [number, number, number, number];

/**
 * Turns one element's collected `details` into the type-specific fields the
 * contract requires for its block type (e.g. `checked` for a checkbox). It
 * reports a problem by throwing a `GroundTruthError`; its issues are listed
 * with the block's location.
 */
export type DetailReader = (
  element: MeasuredElement,
) => Record<string, unknown>;

export type DetailReaders = Partial<Record<BlockType, DetailReader>>;

export interface BuildOptions {
  /** Readers for block types that need more than the common fields. */
  detailReaders?: DetailReaders;
}

/** Thrown when a page can't be turned into a valid gt.json; lists every problem. */
export class GroundTruthError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`ground truth: ${issues.join('; ')}`);
    this.name = 'GroundTruthError';
    this.issues = issues;
  }
}

/** Block types the contract can't express without a detail reader (T13). */
const detailTypes: ReadonlySet<string> = new Set([
  'table',
  'checkbox',
  'formula',
]);

/** T13's `data-gt-*` attributes and the one block type each is allowed on. */
const markupAttributes: Readonly<Record<string, BlockType>> = {
  'data-gt-checked': 'checkbox',
  'data-gt-latex': 'formula',
  'data-gt-text': 'image',
};

const regionRank: Record<Region, number> = {
  top: 0,
  left: 1,
  area: 2,
  right: 3,
  bottom: 4,
};

/** CSS px → PDF pt. */
const ptPerPx = 0.75;

const toPt = (px: number) => Math.round(px * ptPerPx * 100) / 100;

const isBlockType = (type: string): type is BlockType =>
  (blockTypes as readonly string[]).includes(type);

/**
 * Converts a measurement into a validated gt.json: boxes relative to their
 * page in PDF points, pages numbered from 1, reading order page by page
 * (top margin, left, content area, right, bottom margin; document order
 * within each), ids from `data-gt-id` or `<type>-<n>`, a repeated id suffixed
 * `-2`, `-3`, …, and `continues` on every split fragment.
 */
export function buildGroundTruth(
  measurement: Measurement,
  source: GroundTruth['source'],
  options: BuildOptions = {},
): GroundTruth {
  if (measurement.pages.length === 0) {
    throw new GroundTruthError(['no .pagedjs_page on the page']);
  }
  const readers = options.detailReaders ?? {};
  const inOrder = measurement.elements
    .map((element, index) => ({ element, index }))
    .sort(
      (a, b) =>
        a.element.page - b.element.page ||
        regionRank[a.element.region] - regionRank[b.element.region] ||
        a.index - b.index,
    )
    .map(({ element }) => element);

  const issues: string[] = [];
  const blocks: Record<string, unknown>[] = [];
  const autoCounts = new Map<string, number>();
  const idCounts = new Map<string, number>();
  // Base and final id of the latest block with each data-ref.
  const byRef = new Map<string, { base: string; id: string }>();

  for (const element of inOrder) {
    const where = `data-gt="${element.type}"${element.id === null ? '' : ` data-gt-id="${element.id}"`} on page ${element.page + 1}`;
    const problems: string[] = [];
    if (!isBlockType(element.type)) {
      problems.push(`${where}: unknown block type "${element.type}"`);
    }
    if (element.nested) {
      problems.push(`${where}: is nested inside another data-gt element`);
    }
    const reader = isBlockType(element.type)
      ? readers[element.type]
      : undefined;
    if (reader === undefined && detailTypes.has(element.type)) {
      problems.push(
        `${where}: block type "${element.type}" needs a detail reader (T13)`,
      );
    }
    for (const name of Object.keys(element.attributes ?? {})) {
      const owner = markupAttributes[name];
      if (owner === undefined) {
        problems.push(`${where}: unknown attribute ${name}`);
      } else if (owner !== element.type) {
        problems.push(
          `${where}: ${name} is only allowed on data-gt="${owner}"`,
        );
      }
    }
    for (const { tag, name } of element.innerAttributes ?? []) {
      problems.push(
        `${where}: ${name} on <${tag}> inside the block is not allowed`,
      );
    }
    const origin =
      element.splitFrom === null ? undefined : byRef.get(element.splitFrom);
    if (element.splitFrom !== null && origin === undefined) {
      problems.push(
        `${where}: continues data-ref "${element.splitFrom}", which no earlier block has`,
      );
    }
    const page = measurement.pages[element.page];
    if (page === undefined) {
      problems.push(`${where}: no such page`);
    }
    if (problems.length > 0 || page === undefined) {
      issues.push(...problems);
      continue;
    }

    // The same source element again (a split fragment or a repeated clone)
    // keeps the base id of its first appearance.
    let base =
      element.id ??
      origin?.base ??
      (element.ref === null ? undefined : byRef.get(element.ref)?.base);
    if (base === undefined) {
      const n = (autoCounts.get(element.type) ?? 0) + 1;
      autoCounts.set(element.type, n);
      base = `${element.type}-${n}`;
    }
    const seen = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, seen);
    const id = seen === 1 ? base : `${base}-${seen}`;
    if (element.ref !== null) byRef.set(element.ref, { base, id });

    let details: Record<string, unknown> = {};
    try {
      details = reader?.(element) ?? details;
    } catch (error) {
      if (!(error instanceof GroundTruthError)) throw error;
      issues.push(...error.issues.map(issue => `${where}: ${issue}`));
      continue;
    }
    blocks.push({
      id,
      type: element.type,
      page: element.page + 1,
      bbox: bbox(painted(element.rect, element.painted ?? [], page), page),
      order: blocks.length,
      text: element.text.trim(),
      ...(origin === undefined ? {} : { continues: origin.id }),
      ...details,
    });
  }

  const result = gtSchema.safeParse({
    schemaVersion: 1,
    source,
    pages: measurement.pages.map(page => ({
      width: toPt(page.size?.width ?? page.width),
      height: toPt(page.size?.height ?? page.height),
    })),
    blocks,
  });
  if (!result.success) {
    for (const issue of result.error.issues) {
      const [key, index] = issue.path;
      const block =
        key === 'blocks' && typeof index === 'number'
          ? blocks[index]
          : undefined;
      const at = block === undefined ? '' : ` (block "${block.id}")`;
      issues.push(`${issue.path.join('.')}${at}: ${issue.message}`);
    }
  }
  if (issues.length > 0) throw new GroundTruthError(issues);
  if (!result.success) throw new GroundTruthError(['invalid gt.json']);
  return result.data;
}

/** How far a painted box may sit outside a side and still share it, in px. */
const flush = 0.01;

/**
 * The box as Chrome prints it: it paints each painted box on whole px of
 * its page — a replaced element (T08-2), a visible background or border
 * (T08-3), a rebuilt ::before/::after box (T08-4) — or, inside paint
 * containment, of the element's paint-containment frame (T08-7: the ink is
 * the layout moved by the frame's shift, each edge then rounded on its
 * own), so a side the box shares with one moves to where that one paints,
 * and the box grows to cover them all. Where an entry lies is its layout cut at the overflow
 * clips around it (unrounded) and at a clip-path region (T08-5, unrounded);
 * where it paints is the whole-px paint cut at the clips' edges rounded to
 * whole px of the page — of the clipping element's paint-containment frame
 * (T08-7) where it has one — and at the region's exact, unrounded edges.
 * T08-6: an entry may lie outside the box (a descendant's background, border,
 * <img> or <svg> sticking out of it): every side it shares moves as for an
 * inside entry, and any side it lies beyond only grows, cut to the same
 * clips and region; an entry the cuts empty out counts for nothing.
 * Decorations painted outside the border box (T08-4: outlines and outer
 * box-shadows) skip the shared-side rule and apply afterwards, as pure
 * growth: their visible ink only ever moves a side outwards, never inwards;
 * the clip-path region cuts each strip too, without rounding.
 */
function painted(rect: Rect, paintedBoxes: PaintedBox[], page: Rect): Rect {
  const box = edges(rect, page);
  const entries = paintedBoxes
    .filter(({ kind }) => kind !== 'outline' && kind !== 'shadow')
    .map(({ kind, rect, clip, paintClip, clipPath, shift }) => {
      const layout = edges(rect, page);
      let visible = layout;
      // T08-7: the ink is the layout moved by the element's
      // paint-containment frame's shift, each edge then rounded on its own;
      // where the entry lies stays the unmoved layout.
      let ink = paint(
        kind,
        shift === undefined
          ? layout
          : ([
              layout[0] + shift.x,
              layout[1] + shift.y,
              layout[2] + shift.x,
              layout[3] + shift.y,
            ] as Bbox),
      );
      if (clip !== undefined) {
        // The clips cut where the entry lies at their exact edges; its ink
        // is cut where THEY paint: the edges rounded to whole px of the
        // page — of the clipping element's paint-containment frame (T08-7)
        // where it has one.
        const clips = edges(clip, page);
        visible = intersect(visible, clips);
        ink = intersect(
          ink,
          edges(paintClip ?? clip, page).map(Math.round) as Bbox,
        );
      }
      if (clipPath !== undefined) {
        // A clip-path region (T08-5) cuts both at its exact, unrounded
        // edges.
        const region = edges(clipPath, page);
        visible = intersect(visible, region);
        ink = intersect(ink, region);
      }
      if (visible[2] <= visible[0] || visible[3] <= visible[1]) {
        return undefined;
      }
      if (ink[2] <= ink[0] || ink[3] <= ink[1]) return undefined;
      return { visible, ink };
    })
    .filter(entry => entry !== undefined);
  // The visible ink of every outline ring and box-shadow shape, after its
  // clip. A clip-path region (T08-5) cuts each strip at its exact,
  // unrounded edges (the overflow clip itself stays rounded).
  const growth = paintedBoxes
    .filter(({ kind }) => kind === 'outline' || kind === 'shadow')
    .flatMap(entry => {
      const strips =
        entry.kind === 'outline'
          ? outlineStrips(entry, page)
          : shadowStrips(entry, page);
      if (entry.clipPath === undefined) return strips;
      const region = edges(entry.clipPath, page);
      return strips
        .map(strip => intersect(strip, region))
        .filter(strip => strip[2] > strip[0] && strip[3] > strip[1]);
    });
  if (entries.length === 0 && growth.length === 0) return rect;
  const side = (i: 0 | 1 | 2 | 3): number => {
    const outer = i < 2 ? Math.min : Math.max;
    // A shared side is wherever they paint; any other side only grows.
    const shared = entries.some(
      ({ visible }) => Math.abs(visible[i] - box[i]) <= flush,
    );
    return entries.reduce(
      (at, { ink }) => outer(at, ink[i]),
      shared ? (i < 2 ? Infinity : -Infinity) : box[i],
    );
  };
  const sides: Bbox = [side(0), side(1), side(2), side(3)];
  // Growth only: a strip never moves a side inwards.
  for (const strip of growth) {
    sides[0] = Math.min(sides[0], strip[0]);
    sides[1] = Math.min(sides[1], strip[1]);
    sides[2] = Math.max(sides[2], strip[2]);
    sides[3] = Math.max(sides[3], strip[3]);
  }
  const [x0, y0, x1, y1] = sides;
  return { x: x0 + page.x, y: y0 + page.y, width: x1 - x0, height: y1 - y0 };
}

/**
 * The strips of a ring that actually paint, in page px: an outer rect minus
 * an inner hole (what an outline or a box-shadow paints around its rect),
 * cut to the overflow clips around the element. Four strips cover the ring;
 * ones the clip or the ring's own negative width leave empty paint nothing.
 */
function ringStrips(outer: Bbox, inner: Bbox, clip: Bbox): Bbox[] {
  return (
    [
      // Above, below, left of and right of the hole, each within the outer
      // rect (a moved shadow need not surround its hole).
      [outer[0], outer[1], outer[2], Math.min(inner[1], outer[3])],
      [outer[0], Math.max(inner[3], outer[1]), outer[2], outer[3]],
      [
        outer[0],
        Math.max(inner[1], outer[1]),
        Math.min(inner[0], outer[2]),
        Math.min(inner[3], outer[3]),
      ],
      [
        Math.max(inner[2], outer[0]),
        Math.max(inner[1], outer[1]),
        outer[2],
        Math.min(inner[3], outer[3]),
      ],
    ] as Bbox[]
  )
    .map(
      strip =>
        [
          Math.max(strip[0], clip[0]),
          Math.max(strip[1], clip[1]),
          Math.min(strip[2], clip[2]),
          Math.min(strip[3], clip[3]),
        ] as Bbox,
    )
    .filter(strip => strip[2] > strip[0] && strip[3] > strip[1]);
}

/**
 * The strips of one outline ring that actually paint, in page px: the ring
 * lies between the rect edges (the rect moved by the element's
 * paint-containment frame's shift (T08-7), then each edge rounded on its
 * own, as a `box`) grown by the computed outline-offset (inner edge) and
 * grown by offset plus outline-width (outer edge), and it shows only inside the
 * overflow clips around the element (clip edges rounded page-relative too
 * — of the clipping element's paint-containment frame (T08-7) where it has
 * one) and inside a clip-path region (cut at its exact, unrounded edges in
 * `painted`, T08-5).
 */
function outlineStrips(outline: PaintedBox, page: Rect): Bbox[] {
  const [x0, y0, x1, y1] = edges(
    {
      ...outline.rect,
      x: outline.rect.x + (outline.shift?.x ?? 0),
      y: outline.rect.y + (outline.shift?.y ?? 0),
    },
    page,
  ).map(Math.round) as Bbox;
  // Without a clip (an element on no page) only the page cuts it.
  const clip = edges(outline.paintClip ?? outline.clip ?? page, page).map(
    Math.round,
  ) as Bbox;
  const offset = outline.offset ?? 0;
  const width = outline.width ?? 0;
  const inner: Bbox = [x0 - offset, y0 - offset, x1 + offset, y1 + offset];
  const outer: Bbox = [
    inner[0] - width,
    inner[1] - width,
    inner[2] + width,
    inner[3] + width,
  ];
  return ringStrips(outer, inner, clip);
}

/**
 * The strips of one outer box-shadow that actually paint, in page px: the
 * shadow's shape is the rect edges (the rect moved by the element's
 * paint-containment frame's shift (T08-7), then each edge rounded on its
 * own, as a `box`) moved by the shadow's offset and grown on every side by
 * its spread (negative spread shrinks) plus 1.5 × its blur radius (the
 * printed reach of the Gaussian CSS defines: 3σ with σ = blur/2) — offset, spread
 * and blur are not rounded. The shadow paints only outside the rect, so the
 * hole is the rect itself, and on a side the rect lost to a
 * box-decoration-break: slice cut the shape's edge is the rect's own, so
 * nothing paints past it. The overflow clips around the element cut what
 * shows (clip edges rounded page-relative — of the clipping element's
 * paint-containment frame (T08-7) where it has one) and a clip-path region
 * cuts it at its exact, unrounded edges (in `painted`, T08-5).
 */
function shadowStrips(shadow: PaintedBox, page: Rect): Bbox[] {
  const [x0, y0, x1, y1] = edges(
    {
      ...shadow.rect,
      x: shadow.rect.x + (shadow.shift?.x ?? 0),
      y: shadow.rect.y + (shadow.shift?.y ?? 0),
    },
    page,
  ).map(Math.round) as Bbox;
  // Without a clip (an element on no page) only the page cuts it.
  const clip = edges(shadow.paintClip ?? shadow.clip ?? page, page).map(
    Math.round,
  ) as Bbox;
  const grow = (shadow.spread ?? 0) + 1.5 * (shadow.blur ?? 0);
  const [dx = 0, dy = 0] = [shadow.offsetX, shadow.offsetY];
  const sliced = shadow.sliced ?? [];
  const outer: Bbox = [
    sliced.includes('left') ? x0 : x0 + dx - grow,
    y0 + dy - grow,
    sliced.includes('right') ? x1 : x1 + dx + grow,
    y1 + dy + grow,
  ];
  return ringStrips(outer, [x0, y0, x1, y1], clip);
}

/**
 * Where Chrome paints something laid out at `layout` (page px, already
 * moved by the element's paint-containment frame's shift (T08-7) when it
 * has one): an <img>, a background (`box`) or a ::before/::after box
 * (`pseudo`) with each edge
 * rounded; an <svg> from its rounded origin at its own size, clipped to its
 * rounded box.
 */
function paint(kind: PaintedBox['kind'], layout: Bbox): Bbox {
  const [x0, y0, x1, y1] = layout.map(Math.round) as Bbox;
  return kind === 'svg'
    ? [
        x0,
        y0,
        Math.min(x0 + layout[2] - layout[0], x1),
        Math.min(y0 + layout[3] - layout[1], y1),
      ]
    : [x0, y0, x1, y1];
}

/** `[x0, y0, x1, y1]` where two such boxes overlap, in the same units. */
function intersect(a: Bbox, b: Bbox): Bbox {
  return [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
}

/** `[x0, y0, x1, y1]` of a rect relative to the page, in px. */
function edges({ x, y, width, height }: Rect, page: Rect): Bbox {
  return [x - page.x, y - page.y, x - page.x + width, y - page.y + height];
}

/** `[x0, y0, x1, y1]` in pt relative to the page; each edge rounded on its own. */
function bbox(rect: Rect, page: Rect): Bbox {
  return pageBbox({ ...rect, x: rect.x - page.x, y: rect.y - page.y });
}

/** A rect already relative to its page, in CSS px, as a gt.json bbox. */
export function pageBbox({ x, y, width, height }: Rect): Bbox {
  return [toPt(x), toPt(y), toPt(x + width), toPt(y + height)];
}
