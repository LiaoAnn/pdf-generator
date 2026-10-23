import { extractText, getDocumentProxy } from 'unpdf';

// Both sides are compared NFKC-normalised, without whitespace and in lower
// case (text-transform changes case in the PDF but not in the DOM).
const normalise = (text: string) =>
  text.normalize('NFKC').replace(/\s/g, '').toLowerCase();

/**
 * The expected texts (per page, as the print runtime reports them) that the
 * PDF's text layer lacks, as `"page <n>: <text>"`. Each expected text uses up
 * one occurrence on its page, so a text expected twice must be there twice.
 */
export async function missingText(
  pdf: Uint8Array,
  expected: string[][],
): Promise<string[]> {
  // A plain Uint8Array copy: pdf.js refuses Buffers (what puppeteer returns)
  // and may detach the array it is given.
  const document = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const { text: pages } = await extractText(document, { mergePages: false });
    return expected.flatMap((texts, i) => {
      let page = normalise(pages[i] ?? '');
      return texts.flatMap(text => {
        const at = page.indexOf(normalise(text));
        if (at === -1) return [`page ${i + 1}: ${text.slice(0, 40)}`];
        page = page.slice(0, at) + page.slice(at + normalise(text).length);
        return [];
      });
    });
  } finally {
    await document.loadingTask.destroy();
  }
}
