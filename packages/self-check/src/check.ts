import type { GroundTruth, GtBlock } from '@pdf-generator/contract';
import {
  type PdfMark,
  type PdfPage,
  type PdfTextItem,
  readPdf,
} from './pdf.ts';
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
  /**
   * A block with no printed text whose box doesn't fit what the PDF draws
   * there: nothing (`inkBox` absent), a drawing not anchored to its box, or
   * one spilling out of it. `inkBox` is the union of the marks inside or
   * spilling.
   */
  | { kind: 'ink'; page: number; blockId: string; bbox: Box; inkBox?: Box }
  /** The block's order does not fit the page it is printed on. */
  | { kind: 'order'; page: number; blockId: string; order: number }
  /** The PDF's text inside a table cell's box is not the cell's text. */
  | {
      kind: 'cell_text';
      page: number;
      blockId: string;
      row: number;
      col: number;
      expected: string;
      actual: string;
    }
  /**
   * The PDF prints a checkbox's mark (☑ or ☐) with the other state. `row`,
   * `col` and `checkbox` (its index in the cell) are set for a checkbox in a
   * table cell.
   */
  | {
      kind: 'checkbox';
      page: number;
      blockId: string;
      row?: number;
      col?: number;
      checkbox?: number;
      expected: boolean;
      actual: boolean;
    }
  /** The PDF's label after a table cell's checkbox is not its `text`. */
  | {
      kind: 'checkbox_label';
      page: number;
      blockId: string;
      row: number;
      col: number;
      checkbox: number;
      expected: string;
      actual: string;
    }
  /** Text printed in a font that is not one of `CheckOptions.fonts`. */
  | { kind: 'font'; page: number; font: string; text: string }
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

// How far a text-free block's drawing may be off its box. On the 5 packs'
// logos, figure and barcode (local Chrome 1xx) it was at most 0.35 pt off an
// edge and 0.53 pt off centre; 1 pt still catches a box moved by more.
const inkTolerancePt = 1;

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

/**
 * Whether `pieces` (comparable form), each used once and whole, in any order,
 * spell `wanted` exactly. A formula's text items: Chrome paints the spans
 * KaTeX positions (sub/superscripts, fraction parts, delimiters, `\tag`)
 * after the rest of the line, so the PDF's order isn't gt.json's DOM order,
 * and the PDF has nothing to restore it from (KaTeX's HTML is aria-hidden,
 * so a tagged PDF leaves it out of the structure tree). Characters within an
 * item still count in order; two whole items swapped go unnoticed (T14-3).
 */
function covers(pieces: readonly string[], wanted: string): boolean {
  const counts = new Map<string, number>();
  let length = 0;
  for (const piece of pieces) {
    if (piece === '') continue;
    counts.set(piece, (counts.get(piece) ?? 0) + 1);
    length += piece.length;
  }
  if (length !== wanted.length) return false;
  // Positions known not to lead to a cover, with the pieces left then.
  const dead = new Set<string>();
  const from = (at: number): boolean => {
    if (at === wanted.length) return true;
    const key = `${at}:${[...counts.values()].join()}`;
    if (dead.has(key)) return false;
    for (const [piece, count] of counts) {
      if (count === 0 || !wanted.startsWith(piece, at)) continue;
      counts.set(piece, count - 1);
      const found = from(at + piece.length);
      counts.set(piece, count);
      if (found) return true;
    }
    dead.add(key);
    return false;
  };
  return from(0);
}

/** Compares a printed PDF with its gt.json and lists every difference. */
export async function checkPdf(
  pdf: Uint8Array,
  gt: GroundTruth,
  options: CheckOptions = {},
): Promise<SelfCheckReport> {
  const { pages } = await readPdf(pdf);
  const allowedFonts = options.fonts ? new Set(options.fonts) : undefined;
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
    const printed = comparable(joined(own));
    if (
      printed === wanted ||
      (block.type === 'formula' &&
        // KaTeX's hidden MathML copy comes before the visible rendering, and
        // may be painted into the text layer (PR #10).
        ((wanted !== '' && printed.endsWith(wanted)) ||
          covers(
            own.map(item => comparable(item.text)),
            wanted,
          )))
    ) {
      if (own.some(item => outside(item, block.bbox))) {
        report(block.page, boxDifference(block, own));
      }
      // Without printed text, its box is checked against what is drawn.
      const ink =
        own.length === 0
          ? inkDifference(block, pages[block.page - 1])
          : undefined;
      if (ink) report(block.page, ink);
      for (const difference of details(block, own))
        report(block.page, difference);
      continue;
    }
    // The PDF can't show an image's text unless it is printed as text; its
    // drawing is still checked.
    if (block.type === 'image' && own.length === 0) {
      const difference = inkDifference(block, pages[block.page - 1]);
      if (difference) report(block.page, difference);
      continue;
    }
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
    // A table's text is compared cell by cell where cells differ.
    const found = details(block, own);
    if (!found.some(difference => difference.kind === 'cell_text')) {
      report(block.page, {
        kind: 'text',
        page: block.page,
        blockId: block.id,
        expected: block.text,
        actual: joined(own),
        message: `Block ${block.id} on page ${block.page}: the PDF has ${JSON.stringify(joined(own))}, gt.json ${JSON.stringify(block.text)}`,
      });
    }
    for (const difference of found) report(block.page, difference);
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
    // Any other font means a glyph fell back to a system font (T03 Must 6).
    if (allowedFonts) {
      const other = new Map<string, string>();
      for (const item of items[i] ?? []) {
        if (!allowedFonts.has(item.font)) {
          other.set(item.font, (other.get(item.font) ?? '') + item.text);
        }
      }
      for (const [font, text] of other) {
        differences.push({
          kind: 'font',
          page,
          font,
          text: text.slice(0, 40),
          message: `Page ${page} prints ${JSON.stringify(text.slice(0, 40))} in ${font}, which is not one of the pack's fonts`,
        });
      }
    }
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

const unionOf = (boxes: readonly Box[]): Box => [
  round(Math.min(...boxes.map(box => box[0]))),
  round(Math.min(...boxes.map(box => box[1]))),
  round(Math.max(...boxes.map(box => box[2]))),
  round(Math.max(...boxes.map(box => box[3]))),
];

/**
 * Whether a drawing spanning `[a0, a1]` sits in `[b0, b1]` as a box's
 * content does on one axis: on one of its edges, or centred (a barcode's
 * quiet zone, an inset icon).
 */
const anchored = (a0: number, a1: number, b0: number, b1: number) =>
  Math.abs(a0 - b0) <= inkTolerancePt ||
  Math.abs(a1 - b1) <= inkTolerancePt ||
  Math.abs(a0 - b0 - (b1 - a1)) <= inkTolerancePt;

/**
 * Compares a block with no printed text with the marks its page draws. Marks
 * covering its whole box (the page clip, a section background) say nothing
 * about it; the rest overlapping it must lie inside it, and on each axis sit
 * on an edge or in the middle. A block that draws nothing can't be checked
 * and is reported too.
 */
function inkDifference(
  block: GtBlock,
  page: PdfPage | undefined,
): Difference | undefined {
  const t = inkTolerancePt;
  const [x0, y0, x1, y1] = block.bbox;
  const inside: Box[] = [];
  const spilling: Box[] = [];
  // A clip places a drawing but paints nothing: something must be painted.
  let painted = false;
  for (const { kind, box } of page?.marks ?? ([] as PdfMark[])) {
    const [m0, n0, m1, n1] = box;
    if (m0 >= x0 - t && n0 >= y0 - t && m1 <= x1 + t && n1 <= y1 + t) {
      inside.push(box);
      painted ||= kind !== 'clip';
    } else if (
      // Overlapping it, but not covering all of it.
      m0 < x1 - t &&
      m1 > x0 + t &&
      n0 < y1 - t &&
      n1 > y0 + t &&
      !(m0 <= x0 + t && n0 <= y0 + t && m1 >= x1 - t && n1 >= y1 - t)
    ) {
      spilling.push(box);
      painted ||= kind !== 'clip';
    }
  }
  const at = `Block ${block.id} on page ${block.page}`;
  const where = {
    kind: 'ink' as const,
    page: block.page,
    blockId: block.id,
    bbox: block.bbox,
  };
  if (!painted) {
    return {
      ...where,
      message: `${at} has no text and the PDF paints nothing in its box [${block.bbox.join(', ')}], so its box can't be checked`,
    };
  }
  const inkBox = unionOf([...inside, ...spilling]);
  const [u0, v0, u1, v1] = inkBox;
  if (
    spilling.length === 0 &&
    anchored(u0, u1, x0, x1) &&
    anchored(v0, v1, y0, y1)
  ) {
    return undefined;
  }
  return {
    ...where,
    inkBox,
    message: `${at}: the PDF draws at [${inkBox.join(', ')}], which doesn't fit its box [${block.bbox.join(', ')}]`,
  };
}

// Glyphs that print a checkbox's state.
const checkedMarks = new Set(['☑', '☒', '✓', '✔', '✅']);
const uncheckedMarks = new Set(['☐', '□']);

/** The state the first mark glyph in `text` prints, if there is one. */
function markState(text: string): boolean | undefined {
  for (const char of text) {
    if (checkedMarks.has(char)) return true;
    if (uncheckedMarks.has(char)) return false;
  }
  return undefined;
}

const anchorOf = (item: PdfTextItem): [number, number] => [
  (item.x0 + item.x1) / 2,
  item.baseline - anchorEm * item.size,
];

/**
 * The differences in a block's type-specific fields that the PDF can show:
 * a checkbox's printed state; a table's cells, their checkboxes' states and
 * labels.
 */
function details(block: GtBlock, own: readonly Item[]): Difference[] {
  if (block.type === 'checkbox') {
    const actual = markState(joined(own));
    // Without a mark glyph (a native input, a CSS-drawn box) the state is
    // vector graphics, which the text layer doesn't show.
    if (actual === undefined || actual === block.checked) return [];
    return [
      {
        kind: 'checkbox',
        page: block.page,
        blockId: block.id,
        expected: block.checked,
        actual,
        message: `Checkbox ${block.id} on page ${block.page} is printed ${actual ? 'checked' : 'unchecked'}`,
      },
    ];
  }
  if (block.type !== 'table') return [];
  const { cells } = block.table;
  // Each item belongs to the smallest cell whose box contains its anchor.
  const cellItems = cells.map((): Item[] => []);
  for (const item of own) {
    const [x, y] = anchorOf(item);
    let best = -1;
    cells.forEach((cell, i) => {
      if (!contains(cell.bbox, x, y)) return;
      const current = cells[best];
      if (current === undefined || area(cell.bbox) < area(current.bbox)) {
        best = i;
      }
    });
    cellItems[best]?.push(item);
  }
  const at = `${block.id} on page ${block.page}`;
  return cells.flatMap((cell, i) => {
    const found: Difference[] = [];
    const where = {
      page: block.page,
      blockId: block.id,
      row: cell.row,
      col: cell.col,
    };
    const inCell = cellItems[i] ?? [];
    const textMatches = comparable(joined(inCell)) === comparable(cell.text);
    if (!textMatches) {
      found.push({
        kind: 'cell_text',
        ...where,
        expected: cell.text,
        actual: joined(inCell),
        message: `Table ${at}, cell ${cell.row},${cell.col}: the PDF has ${JSON.stringify(joined(inCell))}, gt.json ${JSON.stringify(cell.text)}`,
      });
    }
    const checkboxes = cell.checkboxes ?? [];
    // A checkbox's mark: an item starting inside its box with a mark glyph
    // (Chrome merges the mark with its label when they share a font).
    const marks = checkboxes.map(checkbox =>
      inCell.find(item => {
        const [x0, y0, x1, y1] = checkbox.bbox;
        const [, y] = anchorOf(item);
        return (
          item.x0 >= x0 - boxTolerancePt &&
          item.x0 < x1 &&
          y >= y0 &&
          y <= y1 &&
          markState([...item.text.trim()][0] ?? '') !== undefined
        );
      }),
    );
    const labels = checkboxes.map(() => '');
    for (const item of inCell) {
      const mark = marks.indexOf(item);
      // The label of checkbox k: what follows its box, before the next one.
      const [x, y] = anchorOf(item);
      let k = -1;
      checkboxes.forEach((checkbox, j) => {
        const [x0, y0, , y1] = checkbox.bbox;
        // On an earlier line, or on this line and starting left of it.
        if (y >= y0 && (y > y1 || x0 <= x)) k = j;
      });
      if (k === -1) continue;
      const text =
        mark === -1 ? item.text : [...item.text.trim()].slice(1).join('');
      labels[k] += text;
    }
    checkboxes.forEach((checkbox, k) => {
      const mark = marks[k];
      const actual = mark
        ? markState([...mark.text.trim()][0] ?? '')
        : undefined;
      if (actual !== undefined && actual !== checkbox.checked) {
        found.push({
          kind: 'checkbox',
          ...where,
          checkbox: k,
          expected: checkbox.checked,
          actual,
          message: `Table ${at}, cell ${cell.row},${cell.col}: checkbox ${k + 1} is printed ${actual ? 'checked' : 'unchecked'}`,
        });
      }
      const label = labels[k] ?? '';
      if (textMatches && comparable(label) !== comparable(checkbox.text)) {
        found.push({
          kind: 'checkbox_label',
          ...where,
          checkbox: k,
          expected: checkbox.text,
          actual: label,
          message: `Table ${at}, cell ${cell.row},${cell.col}: checkbox ${k + 1}'s label is ${JSON.stringify(label)}, gt.json ${JSON.stringify(checkbox.text)}`,
        });
      }
    });
    return found;
  });
}
