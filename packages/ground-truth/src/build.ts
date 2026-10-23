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
} from './measurement.ts';

/**
 * Turns one element's collected `details` into the type-specific fields the
 * contract requires for its block type (e.g. `checked` for a checkbox).
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

    blocks.push({
      id,
      type: element.type,
      page: element.page + 1,
      bbox: bbox(element.rect, page),
      order: blocks.length,
      text: element.text.trim(),
      ...(origin === undefined ? {} : { continues: origin.id }),
      ...reader?.(element),
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

/** `[x0, y0, x1, y1]` in pt relative to the page; each edge rounded on its own. */
function bbox(rect: Rect, page: Rect): [number, number, number, number] {
  const x = rect.x - page.x;
  const y = rect.y - page.y;
  return [toPt(x), toPt(y), toPt(x + rect.width), toPt(y + rect.height)];
}
