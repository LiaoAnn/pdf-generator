// Measures how much ink pdf.js and PDFium each draw inside every gt.json
// block of one PDF, and where they draw it, so renderer disagreements are
// found and shown (Chromium prints a CSS repeating gradient as a shading
// pdf.js can't draw, T14-11).
// A dev tool only; nothing in the product imports it.
import { crc32, deflateSync } from 'node:zlib';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import type { GroundTruth } from '@pdf-generator/contract';
import { renderPdfJsPages } from './pdf-to-png.ts';

export interface CompareRenderersOptions {
  /** Pixels per PDF point (default 4). */
  scale?: number;
  /**
   * |pdfjs - pdfium| ink-share difference and the position difference still
   * counted as agreement; position ≥ the share difference, so in practice
   * position decides.
   */
  threshold?: number;
}

export interface RendererInk {
  id: string;
  page: number;
  pdfjs: number;
  pdfium: number;
  /** Where the ink is, not only how much; see compareInk. */
  position: number;
  agree: boolean;
}

export interface CompareRenderersResult {
  /** One entry per gt.blocks element, in the same order. */
  blocks: RendererInk[];
  /** Each page as both renderers drew it, PNG bytes, in page order. */
  pages: { pdfjs: Uint8Array; pdfium: Uint8Array }[];
}

/** One page's RGBA pixels, row-major from the top-left. */
export interface PagePixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** One box's ink in two page images (compareInk). */
export interface BoxInk {
  /** Share of the box's pixels pdf.js draws dark. */
  pdfjs: number;
  /** Share of the box's pixels PDFium draws dark. */
  pdfium: number;
  /**
   * Where the ink is, independent of how much: the box's pixel rect is split
   * into 4 pt cells from its top-left pixel, and the per-cell difference of
   * the two renderers' dark-pixel counts is summed over the box's pixels
   * (the area-weighted mean per-cell share difference, always ≥ |pdfjs −
   * pdfium|). Same ink in the same cells measures 0 however it sits inside
   * each cell; the same amount of ink 4 pt over measures 1.
   */
  position: number;
}

/**
 * Measures one box (gt.json points × scale) on two page images: each
 * renderer's ink share — the same rule as inkShare, pixel centres inside the
 * box, dark below mid-grey composited over white, a missing page all blank —
 * plus `position`, which also compares where the ink is so a misread that
 * redraws it in the wrong place no longer passes: the box's pixel rect is
 * split into square cells of max(1, round(4 × scale)) pixels (4 PDF points)
 * starting at the box's top-left pixel, the last row and column possibly
 * partial, and position is Σ |pdf.js's − PDFium's dark pixels| per cell over
 * the box's pixels. 4 pt because on the known probes 2 pt cells see
 * one-pixel rendering offsets of fine tiles and 8 pt cells average the
 * misread away. A box no pixel centre falls into measures all 0.
 */
export function compareInk(
  pdfjs: PagePixels | undefined,
  pdfium: PagePixels | undefined,
  bbox: readonly [number, number, number, number],
  scale: number,
): BoxInk {
  const zero: BoxInk = { pdfjs: 0, pdfium: 0, position: 0 };
  const page = pdfjs ?? pdfium;
  if (!page) return zero;
  const { width, height } = page;
  const left = Math.max(0, Math.ceil(bbox[0] * scale - 0.5));
  const top = Math.max(0, Math.ceil(bbox[1] * scale - 0.5));
  const right = Math.min(width, Math.ceil(bbox[2] * scale - 0.5));
  const bottom = Math.min(height, Math.ceil(bbox[3] * scale - 0.5));
  const total = (right - left) * (bottom - top);
  if (total <= 0) return zero;
  const dark = (source: PagePixels, x: number, y: number) => {
    const i = (y * source.width + x) * 4;
    const alpha = (source.rgba[i + 3] ?? 0) / 255;
    const composite = (channel: number) => channel * alpha + 255 * (1 - alpha);
    return (
      0.299 * composite(source.rgba[i] ?? 0) +
        0.587 * composite(source.rgba[i + 1] ?? 0) +
        0.114 * composite(source.rgba[i + 2] ?? 0) <
      128
    );
  };
  const cellPx = Math.max(1, Math.round(4 * scale));
  let pdfjsDark = 0;
  let pdfiumDark = 0;
  let difference = 0;
  for (let cellTop = top; cellTop < bottom; cellTop += cellPx) {
    const cellBottom = Math.min(bottom, cellTop + cellPx);
    for (let cellLeft = left; cellLeft < right; cellLeft += cellPx) {
      const cellRight = Math.min(right, cellLeft + cellPx);
      let a = 0;
      let b = 0;
      for (let y = cellTop; y < cellBottom; y++) {
        for (let x = cellLeft; x < cellRight; x++) {
          if (pdfjs && dark(pdfjs, x, y)) a++;
          if (pdfium && dark(pdfium, x, y)) b++;
        }
      }
      pdfjsDark += a;
      pdfiumDark += b;
      difference += Math.abs(a - b);
    }
  }
  return {
    pdfjs: pdfjsDark / total,
    pdfium: pdfiumDark / total,
    position: difference / total,
  };
}

// RGBA as a minimal PNG: unfiltered rows, one zlib-deflated IDAT.
function png({ width, height, rgba }: PagePixels): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Renders `pdf` with both pdf.js (the build packages/self-check reads PDFs
 * with) and PDFium, and returns each block's ink share in both and the
 * position difference of where that ink is, `agree` when both the shares and
 * the position differ by at most `threshold` (position ≥ the share
 * difference, so in practice position decides), plus every page as both
 * renderers drew it.
 */
export async function compareRenderers(
  pdf: Uint8Array,
  gt: GroundTruth,
  { scale = 4, threshold = 0.1 }: CompareRenderersOptions = {},
): Promise<CompareRenderersResult> {
  const pdfjsPages = (await renderPdfJsPages(pdf, scale, [], true)).map(
    ({ width, height, rgba, png }) => {
      if (!rgba) throw new Error('pdf.js returned no pixels');
      return { width, height, rgba, png };
    },
  );
  const library = await PDFiumLibrary.init();
  let pdfiumPages: PagePixels[];
  try {
    const document_ = await library.loadDocument(pdf);
    try {
      // Each page at pdf.js's pixel size for it: PDFium floors the
      // fractional point size, so `scale` alone can land a pixel off.
      pdfiumPages = [];
      const count = Math.min(document_.getPageCount(), pdfjsPages.length);
      for (let i = 0; i < count; i++) {
        const page = document_.getPage(i);
        const target = pdfjsPages[i];
        if (!target) continue;
        try {
          const { width, height, data } = await page.render({
            width: target.width,
            height: target.height,
            render: 'bitmap',
          });
          pdfiumPages.push({ width, height, rgba: data });
        } finally {
          page.close();
        }
      }
    } finally {
      document_.destroy();
    }
  } finally {
    library.destroy();
  }
  return {
    blocks: gt.blocks.map(block => {
      const pdfjs = pdfjsPages[block.page - 1];
      const pdfium = pdfiumPages[block.page - 1];
      const measured = compareInk(pdfjs, pdfium, block.bbox, scale);
      return {
        id: block.id,
        page: block.page,
        pdfjs: measured.pdfjs,
        pdfium: measured.pdfium,
        position: measured.position,
        agree:
          Math.abs(measured.pdfjs - measured.pdfium) <= threshold &&
          measured.position <= threshold,
      };
    }),
    pages: pdfjsPages.map((page, index) => {
      const pdfium = pdfiumPages[index];
      return {
        pdfjs: page.png,
        pdfium: pdfium ? png(pdfium) : new Uint8Array(),
      };
    }),
  };
}
