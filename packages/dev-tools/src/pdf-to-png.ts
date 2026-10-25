// Draws each page of a PDF as a PNG (pdf.js in Playwright's Chromium), for
// visual checks: the T3 preview browser downloads PDFs instead of showing them.
// A dev tool only; nothing in the product imports it.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BlockType, GroundTruth } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';

export interface PdfToPngOptions {
  /** Pixels per PDF point (default 2). */
  scale?: number;
  /** Draws these gt.json boxes over the pages they belong to. */
  gt?: GroundTruth;
}

// The page loads pdf.js and the PDF from this origin, served by page.route.
const origin = 'http://pdf-to-png.invalid';
// pdf.js is imported by the page itself: Vitest rewrites an import() inside
// page.evaluate into a helper the page doesn't have.
const loader = `<!doctype html><script type="module">
  window.pdfjs = await import('/pdfjs.mjs');
</script>`;

declare global {
  interface Window {
    pdfjs?: typeof import('unpdf/pdfjs');
  }
}

/** What is drawn over one page, in pixels. */
interface Overlay {
  /** Outlines: [x0, y0, x1, y1] and a CSS colour. */
  boxes: { box: number[]; color: string }[];
  /** Labels: `text` written in a strip whose top-left corner is x, y. */
  labels: { x: number; y: number; text: string; color: string }[];
}

// Saturated outline colours, one per block type, so a box's type shows.
const typeColors: Record<BlockType, string> = {
  title: '#e6194b',
  heading: '#e6194b',
  paragraph: '#3c78d8',
  list_item: '#3c78d8',
  label: '#f58231',
  field: '#00a86b',
  table: '#911eb4',
  image: '#d4a017',
  caption: '#f032e6',
  formula: '#008080',
  checkbox: '#e6194b',
  barcode: '#d4a017',
  page_header: '#9a6324',
  page_footer: '#9a6324',
  page_number: '#9a6324',
  footnote: '#808000',
  reference: '#808000',
};
const cellColor = '#ff8c00';
const cellCheckboxColor = '#00b7eb';
/** Height of a block's label strip, in pixels. */
const labelHeight = 14;

/**
 * Each page's outlines and labels: every block's bbox with its order and id
 * above it (inside the box when there is no room above), and a table's cells
 * and cell checkboxes. gt.json boxes are in points from the page's top-left,
 * the same corner pdf.js draws from, so they only need `scale`.
 */
function overlays(gt: GroundTruth, scale: number): Overlay[] {
  const pages = gt.pages.map((): Overlay => ({ boxes: [], labels: [] }));
  const scaled = (box: number[]) => box.map(value => value * scale);
  for (const block of [...gt.blocks].sort((a, b) => a.order - b.order)) {
    const overlay = pages[block.page - 1];
    if (!overlay) continue;
    if (block.type === 'table')
      for (const cell of block.table.cells) {
        overlay.boxes.push({ box: scaled(cell.bbox), color: cellColor });
        for (const checkbox of cell.checkboxes ?? [])
          overlay.boxes.push({
            box: scaled(checkbox.bbox),
            color: cellCheckboxColor,
          });
      }
    const box = scaled(block.bbox);
    const [x = 0, y = 0] = box;
    const color = typeColors[block.type];
    overlay.boxes.push({ box, color });
    overlay.labels.push({
      x,
      y: y < labelHeight ? y : y - labelHeight,
      text: `${block.order} ${block.id}`,
      color,
    });
  }
  return pages;
}

/** One PNG file's bytes per page of `pdf`, in page order. */
export async function pdfToPng(
  pdf: Uint8Array,
  { scale = 2, gt }: PdfToPngOptions = {},
): Promise<Uint8Array[]> {
  // unpdf's pdf.js build, the one packages/self-check reads PDFs with.
  const pdfjs = await readFile(
    fileURLToPath(import.meta.resolve('unpdf/pdfjs')),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(`${origin}/**`, route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/pdfjs.mjs')
        return route.fulfill({ body: pdfjs, contentType: 'text/javascript' });
      if (pathname === '/document.pdf')
        return route.fulfill({
          body: Buffer.from(pdf),
          contentType: 'application/pdf',
        });
      return route.fulfill({ body: loader, contentType: 'text/html' });
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.pdfjs);
    const urls = await page.evaluate(
      async ({ scale, overlays, labelHeight }) => {
        if (!window.pdfjs) throw new Error('pdf.js did not load');
        const { getDocument } = window.pdfjs;
        const response = await fetch('/document.pdf');
        const data = new Uint8Array(await response.arrayBuffer());
        const document_ = await getDocument({ data }).promise;
        const urls: string[] = [];
        for (let number = 1; number <= document_.numPages; number++) {
          const pdfPage = await document_.getPage(number);
          const viewport = pdfPage.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no 2d canvas');
          await pdfPage.render({ canvas, canvasContext: context, viewport })
            .promise;
          const overlay = overlays[number - 1];
          // Edges are snapped to whole pixels and filled, 2 px wide, the pixel
          // before and the one at each edge: no anti-aliased fringe.
          for (const { box, color } of overlay?.boxes ?? []) {
            const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box.map(Math.floor);
            context.fillStyle = color;
            context.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, 2);
            context.fillRect(x0 - 1, y1 - 1, x1 - x0 + 2, 2);
            context.fillRect(x0 - 1, y0 - 1, 2, y1 - y0 + 2);
            context.fillRect(x1 - 1, y0 - 1, 2, y1 - y0 + 2);
          }
          context.font = `${labelHeight - 3}px sans-serif`;
          context.textBaseline = 'middle';
          for (const { x, y, text, color } of overlay?.labels ?? []) {
            const left = Math.ceil(x);
            const top = Math.ceil(y);
            context.fillStyle = 'rgba(255, 255, 255, 0.85)';
            context.fillRect(
              left,
              top,
              context.measureText(text).width + 4,
              labelHeight - 1,
            );
            context.fillStyle = color;
            context.fillText(text, left + 2, top + labelHeight / 2);
          }
          urls.push(canvas.toDataURL('image/png'));
        }
        return urls;
      },
      { scale, overlays: gt ? overlays(gt, scale) : [], labelHeight },
    );
    return urls.map(url =>
      Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'),
    );
  } finally {
    await browser.close();
  }
}
