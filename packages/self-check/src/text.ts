import { readPdf } from './pdf.ts';

/**
 * The form texts are compared in: NFKC, no whitespace, lower case
 * (text-transform changes case in the PDF but not in the DOM).
 */
export function normaliseText(text: string): string {
  return text.normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

/**
 * The expected texts (per page, as the print runtime reports them) that the
 * PDF's text layer lacks, as `"page <n>: <text>"`. Each expected text uses up
 * one occurrence on its page, so a text expected twice must be there twice.
 */
export async function missingText(
  pdf: Uint8Array,
  expected: string[][],
): Promise<string[]> {
  const { pages } = await readPdf(pdf);
  return expected.flatMap((texts, i) => {
    let page = normaliseText(
      pages[i]?.items.map(item => item.text).join('') ?? '',
    );
    return texts.flatMap(text => {
      const wanted = normaliseText(text);
      const at = page.indexOf(wanted);
      if (at === -1) return [`page ${i + 1}: ${text.slice(0, 40)}`];
      page = page.slice(0, at) + page.slice(at + wanted.length);
      return [];
    });
  });
}
