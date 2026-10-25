// Draws each page of a PDF as a PNG (pdf.js in Playwright's Chromium), for
// visual checks: the T3 preview browser downloads PDFs instead of showing them.
// A dev tool only; nothing in the product imports it.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export interface PdfToPngOptions {
  /** Pixels per PDF point (default 2). */
  scale?: number;
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

/** One PNG file's bytes per page of `pdf`, in page order. */
export async function pdfToPng(
  pdf: Uint8Array,
  { scale = 2 }: PdfToPngOptions = {},
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
    const urls = await page.evaluate(async scale => {
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
        urls.push(canvas.toDataURL('image/png'));
      }
      return urls;
    }, scale);
    return urls.map(url =>
      Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'),
    );
  } finally {
    await browser.close();
  }
}
