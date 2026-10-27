// T26-2: the barcode's bars sit centred in its data-gt box on the printed
// page. Self-check allows a 1 pt centre offset; T26-1's whole-px layout keeps
// the left and right gaps within 0.017 pt, the old 4mm layout drifted 1.08 pt.
import type { PdfPage } from '@pdf-generator/self-check';

const limit = 0.1;

/**
 * What is wrong with the centring of the ink painted wholly inside `bbox`
 * (the barcode block's gt.json box, in PDF points like `PdfPaint.box`).
 */
export function barcodeCentring(
  page: PdfPage,
  bbox: [number, number, number, number],
): string[] {
  const [x0, y0, x1, y1] = bbox;
  const ink = page.paints
    .map(paint => paint.box)
    .filter(
      box => box[0] >= x0 && box[1] >= y0 && box[2] <= x1 && box[3] <= y1,
    );
  if (ink.length === 0) return ['barcode: no ink inside its box'];
  const left = Math.min(...ink.map(box => box[0])) - x0;
  const right = x1 - Math.max(...ink.map(box => box[2]));
  const difference = Math.abs(left - right);
  return difference <= limit
    ? []
    : [
        `barcode off centre: gaps ${left.toFixed(2)} / ${right.toFixed(2)} pt differ by ${difference.toFixed(3)} pt (limit ${limit} pt)`,
      ];
}
