import { readPdf } from './pdf.ts';

/**
 * The form texts are compared in: NFKC, no whitespace, lower case
 * (text-transform changes case in the PDF but not in the DOM).
 */
export function normaliseText(text: string): string {
  return text.normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

/** One `data-gt` element on a page, as the print runtime reports it. */
export interface ExpectedBlock {
  /** Its border box on its page, in PDF points from the top left (y down). */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Its visible text nodes' texts, in DOM order. */
  texts: string[];
}

// An item is printed inside a block when its anchor's height (T03 §1, as in
// check.ts) lies in the block's box and its x range overlaps the box's, both
// by 1 pt for subpixel layout. Overlap rather than the anchor's x: an
// untagged print holds adjacent spans in one font as one item ("Meeting
// date:2026-10-24"), which then counts for each block it crosses.
const anchorEm = 0.35;
const tolerancePt = 1;

/**
 * The expected texts (per page and block, as the print runtime reports them)
 * that the PDF's text layer lacks, as `"page <n>: <text>"`. A block's texts
 * are looked for only in the text printed inside its box, so a formula's
 * single letters can't use up another block's letters (T07-6). Each text uses
 * up one occurrence there, longest first, so a text expected twice must be
 * there twice and a letter can't take one out of a longer word.
 */
export async function missingText(
  pdf: Uint8Array,
  expected: ExpectedBlock[][],
): Promise<string[]> {
  const { pages } = await readPdf(pdf);
  return expected.flatMap((blocks, i) => {
    const items = pages[i]?.items ?? [];
    return blocks.flatMap(({ box, texts }) => {
      let printed = normaliseText(
        items
          .filter(item => {
            const overlap =
              Math.min(item.x1, box.x1) - Math.max(item.x0, box.x0);
            const y = item.baseline - anchorEm * item.size;
            return (
              overlap > tolerancePt &&
              y >= box.y0 - tolerancePt &&
              y <= box.y1 + tolerancePt
            );
          })
          .map(item => item.text)
          .join(''),
      );
      const missing = new Set<number>();
      const longestFirst = texts
        .map((text, at) => ({ at, wanted: normaliseText(text) }))
        .sort((a, b) => b.wanted.length - a.wanted.length || a.at - b.at);
      for (const { at, wanted } of longestFirst) {
        const found = printed.indexOf(wanted);
        if (found === -1) missing.add(at);
        else
          printed =
            printed.slice(0, found) + printed.slice(found + wanted.length);
      }
      return texts
        .filter((_, at) => missing.has(at))
        .map(text => `page ${i + 1}: ${text.slice(0, 40)}`);
    });
  });
}
