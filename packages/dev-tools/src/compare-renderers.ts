// Measures how much ink pdf.js and PDFium each draw inside every gt.json
// block of one PDF, so renderer disagreements are found and shown (Chromium
// prints a CSS repeating gradient as a shading pdf.js can't draw, T14-11).
// A dev tool only; nothing in the product imports it.
import { crc32, deflateSync } from 'node:zlib';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import type { GroundTruth } from '@pdf-generator/contract';
import { renderPdfJsPages } from './pdf-to-png.ts';

export interface CompareRenderersOptions {
  /** Pixels per PDF point (default 4). */
  scale?: number;
  /** |pdfjs - pdfium| ink-share difference still counted as agreement. */
  threshold?: number;
}

export interface RendererInk {
  id: string;
  page: number;
  pdfjs: number;
  pdfium: number;
  agree: boolean;
}

export interface CompareRenderersResult {
  /** One entry per gt.blocks element, in the same order. */
  blocks: RendererInk[];
  /** Each page as both renderers drew it, PNG bytes, in page order. */
  pages: { pdfjs: Uint8Array; pdfium: Uint8Array }[];
}

/** One page's RGBA pixels, row-major from the top-left. */
interface PagePixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Ink share of one box in one page image: the pixels whose centres lie inside
 * the box (gt.json points × scale, y down from the page top, the same corner
 * both renderers draw from), and of those the share that are dark: luminance
 * 0.299R + 0.587G + 0.114B, composited over white by the pixel's alpha, below
 * 128. A box no pixel centre falls into has share 0.
 */
function inkShare(
  { width, height, rgba }: PagePixels,
  [x0, y0, x1, y1]: readonly [number, number, number, number],
  scale: number,
): number {
  const left = Math.max(0, Math.ceil(x0 * scale - 0.5));
  const top = Math.max(0, Math.ceil(y0 * scale - 0.5));
  const right = Math.min(width, Math.ceil(x1 * scale - 0.5));
  const bottom = Math.min(height, Math.ceil(y1 * scale - 0.5));
  let dark = 0;
  const total = (right - left) * (bottom - top);
  if (total <= 0) return 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      const alpha = (rgba[i + 3] ?? 0) / 255;
      const composite = (channel: number) =>
        channel * alpha + 255 * (1 - alpha);
      const luminance =
        0.299 * composite(rgba[i] ?? 0) +
        0.587 * composite(rgba[i + 1] ?? 0) +
        0.114 * composite(rgba[i + 2] ?? 0);
      if (luminance < 128) dark++;
    }
  }
  return dark / total;
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
 * with) and PDFium, and returns each block's ink share in both, `agree` when
 * the shares differ by at most `threshold`, plus every page as both renderers
 * drew it.
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
      const ink: RendererInk = {
        id: block.id,
        page: block.page,
        pdfjs: pdfjs ? inkShare(pdfjs, block.bbox, scale) : 0,
        pdfium: pdfium ? inkShare(pdfium, block.bbox, scale) : 0,
        agree: false,
      };
      ink.agree = Math.abs(ink.pdfjs - ink.pdfium) <= threshold;
      return ink;
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
