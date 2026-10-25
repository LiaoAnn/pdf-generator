// The scale Chrome printed each page at (T07-18). Ground truth is measured at
// 1 CSS px = 0.75 pt; a document that overflows its page in Chrome's print
// layout (CSS columns on the page container, for one) is shrunk to fit, which
// moves every box while the DOM, where the print runtime checks the page
// boxes, is unchanged. Only the PDF shows it.
import { type getDocumentProxy, getResolvedPDFJS } from 'unpdf';

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const ptPerPx = 0.75;

/**
 * `"page <n> …"` for every page that paints plain ink (the print runtime's
 * `plainInk`: text, backgrounds or borders outside SVG and CSS transforms)
 * but draws no text or path at 0.75 pt per CSS px. Chrome writes each
 * drawing's full transform, so plain ink of an unscaled page is drawn at
 * exactly that scale.
 */
export async function scaledPages(
  pdf: PdfDocument,
  plainInk: boolean[] = [],
): Promise<string[]> {
  const { OPS } = await getResolvedPDFJS();
  const drawing = new Set([
    OPS.constructPath,
    OPS.showText,
    OPS.showSpacedText,
  ]);
  const scaled: string[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    if (!plainInk[number - 1]) continue;
    const { fnArray, argsArray } = await (
      await pdf.getPage(number)
    ).getOperatorList();
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const saved: Matrix[] = [];
    const native = fnArray.some((fn: number, i: number) => {
      if (fn === OPS.save) saved.push(ctm);
      else if (fn === OPS.restore) ctm = saved.pop() ?? ctm;
      else if (fn === OPS.transform) {
        ctm = multiply(ctm, argsArray[i] as Matrix);
      } else if (drawing.has(fn)) {
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
        return Math.abs(scale - ptPerPx) <= 0.002;
      }
      return false;
    });
    if (!native) {
      scaled.push(
        `page ${number} printed at another scale: none of its text, backgrounds or borders is drawn at 0.75 pt per CSS px`,
      );
    }
  }
  return scaled;
}
