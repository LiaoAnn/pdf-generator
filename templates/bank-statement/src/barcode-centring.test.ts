import type { PdfPage, PdfPaint } from '@pdf-generator/self-check';
import { describe, expect, it } from 'vitest';

type Box = [number, number, number, number];
const bbox: Box = [100, 200, 300, 240];

function paint(box: Box): PdfPaint {
  const [x0, y0, x1, y1] = box;
  return {
    polygons: [[x0, y0, x1, y0, x1, y1, x0, y1]],
    rule: 'nonzero',
    color: '#000000',
    alpha: 1,
    clips: [],
    box,
  };
}

function page(paints: PdfPaint[]): PdfPage {
  return { width: 595, height: 842, items: [], marks: [], paints };
}

describe('printed barcode centring', () => {
  it('reports the old CSS offset with both two-decimal gaps and a three-decimal difference', async () => {
    const { barcodeCentring } = await import('./barcode-centring.ts');
    // Gaps 6.974 and 8.05 reproduce the old offset without rounding the
    // measurement before computing its 1.076 pt difference.
    const problems = barcodeCentring(
      page([
        paint([200, 204, 202, 236]),
        paint([290, 204, 291.95, 236]),
        paint([106.974, 204, 108, 236]),
      ]),
      bbox,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^barcode/u);
    expect(problems[0]).toContain('6.97');
    expect(problems[0]).toContain('8.05');
    expect(problems[0]).toContain('1.076');
  });

  it('accepts centred ink, the corrected 0.017 pt offset, and the inclusive 0.1 pt limit in either direction', async () => {
    const { barcodeCentring } = await import('./barcode-centring.ts');
    for (const offset of [0, 0.017, -0.017, 0.1, -0.1]) {
      expect(
        barcodeCentring(page([paint([110 + offset, 204, 290, 236])]), bbox),
        `offset ${offset} pt must pass`,
      ).toEqual([]);
    }
  });

  it('rejects offsets just beyond 0.1 pt in either direction without rounding them down', async () => {
    const { barcodeCentring } = await import('./barcode-centring.ts');
    for (const offset of [0.1001, -0.1001]) {
      const problems = barcodeCentring(
        page([paint([110 + offset, 204, 290, 236])]),
        bbox,
      );
      expect(problems, `offset ${offset} pt must fail`).toHaveLength(1);
      expect(problems[0]).toMatch(/^barcode/u);
    }
  });

  it('ignores background, below-block ink, every partly outside edge, text, and marks when measuring centred bars', async () => {
    const { barcodeCentring } = await import('./barcode-centring.ts');
    const printed = page([
      paint([0, 0, 595, 842]),
      paint([101, 245, 280, 255]),
      paint([99, 210, 130, 230]),
      paint([270, 210, 301, 230]),
      paint([101, 199, 130, 230]),
      paint([101, 210, 130, 241]),
      paint([110, 204, 112, 236]),
      paint([288, 204, 290, 236]),
    ]);
    printed.items.push({
      text: '*1234567890*',
      x0: 101,
      x1: 280,
      baseline: 220,
      size: 10,
      font: 'NotoSansTC-Regular',
    });
    printed.marks.push({ kind: 'path', box: [101, 210, 280, 230] });

    expect(barcodeCentring(printed, bbox)).toEqual([]);
  });

  it('includes paints touching each bbox edge instead of discarding boundary bars', async () => {
    const { barcodeCentring } = await import('./barcode-centring.ts');
    expect(
      barcodeCentring(
        page([paint([100, 200, 102, 240]), paint([298, 200, 300, 240])]),
        bbox,
      ),
    ).toEqual([]);
  });

  it('reports missing ink for an empty page or a block containing only text, marks, and outside paints', async () => {
    const { barcodeCentring } = await import('./barcode-centring.ts');
    const withoutInk = page([
      paint([0, 0, 595, 842]),
      paint([110, 245, 290, 255]),
    ]);
    withoutInk.items.push({
      text: '*1234567890*',
      x0: 110,
      x1: 290,
      baseline: 220,
      size: 10,
      font: 'NotoSansTC-Regular',
    });
    withoutInk.marks.push({ kind: 'path', box: [110, 204, 290, 236] });

    for (const printed of [page([]), withoutInk]) {
      const problems = barcodeCentring(printed, bbox);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^barcode/u);
    }
  });
});
