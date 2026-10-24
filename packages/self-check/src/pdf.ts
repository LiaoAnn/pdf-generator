import { getDocumentProxy } from 'unpdf';

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

export interface PdfPage {
  /** MediaBox size in PDF points. */
  width: number;
  height: number;
  /** Text items with visible text (whitespace-only items left out), in content-stream order. */
  items: PdfTextItem[];
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
  try {
    const pages: PdfPage[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const [left = 0, , right = 0, top = 0] = page.view;
      const bottom = page.view[1] ?? 0;
      const content = await page.getTextContent();
      // Fonts are resolved into commonObjs only once the page's operators
      // have been read.
      await page.getOperatorList();
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
      pages.push({ width: right - left, height: top - bottom, items });
      page.cleanup();
    }
    return { pages };
  } finally {
    await document.loadingTask.destroy();
  }
}
