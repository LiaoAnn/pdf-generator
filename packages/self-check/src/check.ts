import type { GroundTruth, GtBlock } from '@pdf-generator/contract';
import { type PdfPage, type PdfTextItem, readPdf } from './pdf.ts';
import { normaliseText } from './text.ts';

/** `[x0, y0, x1, y1]` in PDF points from the page's top-left corner. */
export type Box = [number, number, number, number];

export interface CheckOptions {
  /**
   * PostScript names of the fonts the pack may use (e.g.
   * `NotoSansTC-Regular`). Without it, fonts are not checked.
   */
  fonts?: readonly string[];
}

/** One way the PDF differs from its gt.json. `message` is for people. */
export type Difference = { message: string } & (
  | { kind: 'page_count'; expected: number; actual: number }
  | {
      kind: 'page_size';
      page: number;
      expected: [number, number];
      actual: [number, number];
    }
  /** The PDF's text inside the block's box is not the block's text. */
  | {
      kind: 'text';
      page: number;
      blockId: string;
      expected: string;
      actual: string;
    }
  /** The block's text is printed (partly) outside its box, at `textBox`. */
  | { kind: 'bbox'; page: number; blockId: string; bbox: Box; textBox: Box }
  /** The block's text is printed on `actualPage`, not on `page`. */
  | { kind: 'page'; page: number; blockId: string; actualPage: number }
  /** PDF text inside no block's box. */
  | { kind: 'unmarked_text'; page: number; text: string; textBox: Box }
  /** The block's order does not fit the page it is printed on. */
  | { kind: 'order'; page: number; blockId: string; order: number }
);

export interface SelfCheckReport {
  /** True when there are no differences. */
  ok: boolean;
  differences: Difference[];
}

// Chrome prints A4 with a MediaBox of 594.96 × 841.92 pt, while gt.json
// keeps the declared 595.28 × 841.89 (PR #7): 0.32 pt off. 1 pt allows that
// and Chrome's 1/64 px layout snapping, and still catches a wrong page size.
const pageSizeTolerancePt = 1;

// A text item belongs to the block whose box contains its horizontal centre,
// 0.35 em above its baseline: the point T03 used to match PDF text to boxes
// (docs/findings/T03.md §1).
const anchorEm = 0.35;

// How far a block's text may stick out of its box. T03 §4 found the PDF's
// text edges within 0.01 pt of the DOM's horizontally, and gt.json rounds
// each edge to 0.01 pt; 1 pt leaves room for other Chrome versions (local
// 126 and 153, Browser Rendering 152) and still catches a box moved by more.
const boxTolerancePt = 1;

// The part of a glyph checked against its box vertically: from the baseline
// to 0.7 em above it. A line box contains it even at line-height 1 with
// Noto Sans TC's tall metrics (ascent 1.16, descent 0.288 em: the line box
// starts 0.936 em above the baseline), so tight leading is no false alarm.
const glyphBodyEm = 0.7;

type Item = PdfTextItem & { index: number };

const round = (value: number) => Math.round(value * 100) / 100;

const comparable = (text: string) =>
  // Chrome's text layer for Noto's `——` ligature is U+0000, or U+2015 twice
  // with ccmp off (T03 §2.5).
  normaliseText(text.replace(/―/g, '—').replace(/\0/g, '——'));

const joined = (items: readonly Item[]) =>
  items.map(item => item.text).join('');

const inkBox = (item: PdfTextItem): Box => [
  item.x0,
  item.baseline - glyphBodyEm * item.size,
  item.x1,
  item.baseline,
];

function unionBox(items: readonly Item[]): Box {
  const boxes = items.map(inkBox);
  return [
    round(Math.min(...boxes.map(box => box[0]))),
    round(Math.min(...boxes.map(box => box[1]))),
    round(Math.max(...boxes.map(box => box[2]))),
    round(Math.max(...boxes.map(box => box[3]))),
  ];
}

const contains = (box: readonly number[], x: number, y: number) =>
  x >= (box[0] ?? 0) &&
  x <= (box[2] ?? 0) &&
  y >= (box[1] ?? 0) &&
  y <= (box[3] ?? 0);

const area = (box: readonly number[]) =>
  ((box[2] ?? 0) - (box[0] ?? 0)) * ((box[3] ?? 0) - (box[1] ?? 0));

const outside = (item: PdfTextItem, box: readonly number[]) => {
  const [x0, y0, x1, y1] = inkBox(item);
  return (
    x0 < (box[0] ?? 0) - boxTolerancePt ||
    y0 < (box[1] ?? 0) - boxTolerancePt ||
    x1 > (box[2] ?? 0) + boxTolerancePt ||
    y1 > (box[3] ?? 0) + boxTolerancePt
  );
};

/**
 * The contiguous run of `items` whose text is `wanted` (comparable form),
 * starting and ending on item boundaries; undefined if there is none.
 */
function findRun(items: readonly Item[], wanted: string): Item[] | undefined {
  if (wanted === '') return undefined;
  for (let start = 0; start < items.length; start++) {
    let text = '';
    for (let end = start; end < items.length; end++) {
      text += comparable(items[end]?.text ?? '');
      if (!wanted.startsWith(text)) break;
      if (text === wanted) return items.slice(start, end + 1);
    }
  }
  return undefined;
}

/** Compares a printed PDF with its gt.json and lists every difference. */
export async function checkPdf(
  pdf: Uint8Array,
  gt: GroundTruth,
  _options: CheckOptions = {},
): Promise<SelfCheckReport> {
  const { pages } = await readPdf(pdf);
  const differences: Difference[] = [];

  if (pages.length !== gt.pages.length) {
    differences.push({
      kind: 'page_count',
      expected: gt.pages.length,
      actual: pages.length,
      message: `The PDF has ${pages.length} pages; gt.json has ${gt.pages.length}`,
    });
  }
  gt.pages.forEach((expected, i) => {
    const page = pages[i];
    if (
      page &&
      (Math.abs(page.width - expected.width) > pageSizeTolerancePt ||
        Math.abs(page.height - expected.height) > pageSizeTolerancePt)
    ) {
      const actual: [number, number] = [round(page.width), round(page.height)];
      differences.push({
        kind: 'page_size',
        page: i + 1,
        expected: [expected.width, expected.height],
        actual,
        message: `Page ${i + 1} is ${actual[0]} × ${actual[1]} pt; gt.json says ${expected.width} × ${expected.height}`,
      });
    }
  });

  // Each page's items, and which block each belongs to: of the blocks whose
  // box contains its anchor, one whose text contains the item's text (boxes
  // can overlap when gt.json is wrong), then the smallest.
  const blocks = [...gt.blocks].sort((a, b) => a.order - b.order);
  const wantedText = new Map(
    blocks.map(block => [block, comparable(block.text)]),
  );
  const items: Item[][] = pages.map((page: PdfPage) =>
    page.items.map((item, index) => ({ ...item, index })),
  );
  const owner: (GtBlock | undefined)[][] = items.map((pageItems, i) =>
    pageItems.map(item => {
      const x = (item.x0 + item.x1) / 2;
      const y = item.baseline - anchorEm * item.size;
      const text = comparable(item.text);
      const rank = (block: GtBlock) => [
        wantedText.get(block)?.includes(text) ? 0 : 1,
        area(block.bbox),
      ];
      let best: GtBlock | undefined;
      for (const block of blocks) {
        if (block.page !== i + 1 || !contains(block.bbox, x, y)) continue;
        if (best === undefined) {
          best = block;
          continue;
        }
        const [a0 = 0, a1 = 0] = rank(block);
        const [b0 = 0, b1 = 0] = rank(best);
        if (a0 < b0 || (a0 === b0 && a1 < b1)) best = block;
      }
      return best;
    }),
  );
  const ownedBy = (block: GtBlock, page: number) =>
    (items[page - 1] ?? []).filter((_, j) => owner[page - 1]?.[j] === block);

  // Block differences, keyed by the page they are reported on.
  const byPage = new Map<number, Difference[]>();
  const report = (page: number, difference: Difference) => {
    byPage.set(page, [...(byPage.get(page) ?? []), difference]);
  };
  // The page the PDF shows each block on.
  const shownOn = new Map<GtBlock, number>();

  for (const block of blocks) {
    shownOn.set(block, block.page);
    const own = ownedBy(block, block.page);
    const wanted = comparable(block.text);
    if (comparable(joined(own)) === wanted) {
      if (own.some(item => outside(item, block.bbox))) {
        report(block.page, boxDifference(block, own));
      }
      continue;
    }
    // The PDF can't show an image's text unless it is printed as text.
    if (block.type === 'image' && own.length === 0) continue;
    // Its text elsewhere on its page: among its own and unclaimed items.
    const pageItems = items[block.page - 1] ?? [];
    const pageOwner = owner[block.page - 1] ?? [];
    const run = findRun(
      pageItems.filter(
        (_, j) => pageOwner[j] === block || pageOwner[j] === undefined,
      ),
      wanted,
    );
    if (run) {
      for (const item of own) pageOwner[item.index] = undefined;
      for (const item of run) pageOwner[item.index] = block;
      report(block.page, boxDifference(block, run));
      continue;
    }
    // Its text on another page, among unclaimed items.
    const moved = pages.flatMap((_, i) => {
      if (i + 1 === block.page) return [];
      const found = findRun(
        (items[i] ?? []).filter((_, j) => owner[i]?.[j] === undefined),
        wanted,
      );
      return found ? [{ page: i + 1, found }] : [];
    })[0];
    if (moved) {
      for (const item of moved.found) {
        const pageOwners = owner[moved.page - 1];
        if (pageOwners) pageOwners[item.index] = block;
      }
      shownOn.set(block, moved.page);
      report(block.page, {
        kind: 'page',
        page: block.page,
        blockId: block.id,
        actualPage: moved.page,
        message: `Block ${block.id} is printed on page ${moved.page}, not page ${block.page}`,
      });
      continue;
    }
    report(block.page, {
      kind: 'text',
      page: block.page,
      blockId: block.id,
      expected: block.text,
      actual: joined(own),
      message: `Block ${block.id} on page ${block.page}: the PDF has ${JSON.stringify(joined(own))}, gt.json ${JSON.stringify(block.text)}`,
    });
  }

  // Reading order: the blocks a page shows hold the next run of orders.
  const counts = new Map<number, number>();
  for (const page of shownOn.values())
    counts.set(page, (counts.get(page) ?? 0) + 1);
  for (const block of blocks) {
    const page = shownOn.get(block) ?? block.page;
    let first = 0;
    for (const [other, count] of counts) if (other < page) first += count;
    const last = first + (counts.get(page) ?? 0) - 1;
    if (block.order < first || block.order > last) {
      report(page, {
        kind: 'order',
        page,
        blockId: block.id,
        order: block.order,
        message: `Block ${block.id} has order ${block.order}, but the blocks on page ${page} have orders ${first}–${last}`,
      });
    }
  }

  const orderOf = (difference: Difference) =>
    'blockId' in difference
      ? (blocks.find(block => block.id === difference.blockId)?.order ?? 0)
      : 0;
  for (let i = 0; i < Math.max(pages.length, gt.pages.length); i++) {
    const page = i + 1;
    // Stable: a block's own differences keep the order they were found in.
    differences.push(
      ...(byPage.get(page) ?? []).sort((a, b) => orderOf(a) - orderOf(b)),
    );
    // Runs of consecutive items that no block claims.
    let run: Item[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const text = joined(run);
      differences.push({
        kind: 'unmarked_text',
        page,
        text,
        textBox: unionBox(run),
        message: `Page ${page} prints ${JSON.stringify(text)} outside every block`,
      });
      run = [];
    };
    (items[i] ?? []).forEach((item, j) => {
      if (owner[i]?.[j] === undefined) run.push(item);
      else flush();
    });
    flush();
  }

  return { ok: differences.length === 0, differences };
}

function boxDifference(block: GtBlock, items: readonly Item[]): Difference {
  const textBox = unionBox(items);
  return {
    kind: 'bbox',
    page: block.page,
    blockId: block.id,
    bbox: block.bbox,
    textBox,
    message: `Block ${block.id} on page ${block.page}: its text is printed at [${textBox.join(', ')}], outside its box [${block.bbox.join(', ')}]`,
  };
}
