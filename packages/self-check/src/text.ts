import { type PdfTextItem, readPdf } from './pdf.ts';

/**
 * The form texts are compared in: NFKC, no whitespace or U+200B (KaTeX's
 * `.vlist-s` filler, which the PDF doesn't print; T14-3), lower case
 * (text-transform changes case in the PDF but not in the DOM).
 */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\u200b]/g, '')
    .toLowerCase();
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One `data-gt` element on a page, as the print runtime reports it. */
export interface ExpectedBlock {
  /**
   * Its visible text nodes, in DOM order: each one's text and its client
   * rects (one per line fragment) on its page, in PDF points from the top
   * left (y down).
   */
  texts: { text: string; boxes: Box[] }[];
}

// An item is printed inside a text's box when its anchor's height (T03 §1, as
// in check.ts) lies in the box and its x range overlaps the box's, both by
// 1 pt for subpixel layout. Overlap rather than the anchor's x: an untagged
// print holds adjacent spans in one font as one item ("Meeting
// date:2026-10-24"), which then counts for each text it crosses.
const anchorEm = 0.35;
const tolerancePt = 1;

function inside(item: PdfTextItem, box: Box): boolean {
  const overlap = Math.min(item.x1, box.x1) - Math.max(item.x0, box.x0);
  const y = item.baseline - anchorEm * item.size;
  return (
    overlap > tolerancePt &&
    y >= box.y0 - tolerancePt &&
    y <= box.y1 + tolerancePt
  );
}

/**
 * The expected texts (per page and block, as the print runtime reports them)
 * that the PDF's text layer lacks, as `"page <n>: <text>"`. A text is looked
 * for only in the items printed inside its own boxes, joined in
 * content-stream order, so neither a formula's single letters (T07-6) nor a
 * neighbouring table cell (T07-12) can lend it characters, while a text that
 * prints as several items (wrapped, letter-spaced, a ligature) still matches.
 * Each text uses up its characters in its block, longest first, so a text
 * expected twice must be there twice and a letter can't take one out of a
 * longer word.
 */
export async function missingText(
  pdf: Uint8Array,
  expected: ExpectedBlock[][],
): Promise<string[]> {
  const { pages } = await readPdf(pdf);
  return expected.flatMap((blocks, i) => {
    const items = pages[i]?.items ?? [];
    return blocks.flatMap(({ texts }) => {
      // What is left of each item's text for this block's other texts.
      const left = items.map(item => normaliseText(item.text));
      const missing = new Set<number>();
      const longestFirst = texts
        .map(({ text, boxes }, at) => ({
          at,
          boxes,
          wanted: normaliseText(text),
        }))
        .sort((a, b) => b.wanted.length - a.wanted.length || a.at - b.at);
      for (const { at, boxes, wanted } of longestFirst) {
        const own = items.flatMap((item, n) =>
          boxes.some(box => inside(item, box)) ? [n] : [],
        );
        let rest = own
          .map(n => left[n])
          .join('')
          .indexOf(wanted);
        if (rest === -1) {
          missing.add(at);
          continue;
        }
        // Take the match out of the items it spans.
        let length = wanted.length;
        for (const n of own) {
          const text = left[n] ?? '';
          if (rest >= text.length) {
            rest -= text.length;
            continue;
          }
          const taken = Math.min(length, text.length - rest);
          left[n] = text.slice(0, rest) + text.slice(rest + taken);
          length -= taken;
          rest = 0;
          if (length === 0) break;
        }
      }
      return texts
        .filter((_, at) => missing.has(at))
        .map(({ text }) => `page ${i + 1}: ${text.slice(0, 40)}`);
    });
  });
}
