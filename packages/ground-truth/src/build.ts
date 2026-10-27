import {
  type BlockType,
  blockTypes,
  type GroundTruth,
  gtSchema,
} from '@pdf-generator/contract';
import type {
  MeasuredElement,
  Measurement,
  Rect,
  Region,
  ReplacedBox,
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
      bbox: bbox(painted(element.rect, element.replaced ?? [], page), page),
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

/** How far a replaced element may sit outside a side and still share it, in px. */
const flush = 0.01;

/**
 * The box as Chrome prints it (T08-2): it paints each replaced element inside
 * the box on whole px of its page, so a side the box shares with one moves to
 * where that one is painted, and the box grows to cover them all. Ones that
 * stick out of the box (clipped, say) are left out.
 */
function painted(rect: Rect, replaced: ReplacedBox[], page: Rect): Rect {
  const box = edges(rect, page);
  const inside = replaced
    .map(({ kind, rect }) => ({ kind, layout: edges(rect, page) }))
    .filter(
      ({ layout }) =>
        layout[0] >= box[0] - flush &&
        layout[1] >= box[1] - flush &&
        layout[2] <= box[2] + flush &&
        layout[3] <= box[3] + flush,
    )
    .map(({ kind, layout }) => ({ layout, paint: paint(kind, layout) }));
  if (inside.length === 0) return rect;
  const side = (i: 0 | 1 | 2 | 3): number => {
    const outer = i < 2 ? Math.min : Math.max;
    const shared = inside
      .filter(({ layout }) => Math.abs(layout[i] - box[i]) <= flush)
      .map(({ paint }) => paint[i]);
    const at = shared.length > 0 ? outer(...shared) : box[i];
    return outer(at, ...inside.map(({ paint }) => paint[i]));
  };
  const [x0, y0, x1, y1] = [side(0), side(1), side(2), side(3)];
  return { x: x0 + page.x, y: y0 + page.y, width: x1 - x0, height: y1 - y0 };
}

/**
 * Where Chrome paints a replaced element laid out at `layout` (page px): an
 * <img> with each edge rounded; an <svg> from its rounded origin at its own
 * size, clipped to its rounded box.
 */
function paint(kind: ReplacedBox['kind'], layout: Bbox): Bbox {
  const [x0, y0, x1, y1] = layout.map(Math.round) as Bbox;
  return kind === 'img'
    ? [x0, y0, x1, y1]
    : [
        x0,
        y0,
        Math.min(x0 + layout[2] - layout[0], x1),
        Math.min(y0 + layout[3] - layout[1], y1),
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
