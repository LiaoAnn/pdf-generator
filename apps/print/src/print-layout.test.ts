import { fileURLToPath, URL } from 'node:url';
import { getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';

const token = 'slice-two-layout-test-token';
type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;
let worker: Worker;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    bindings: { PRINT_TOKEN: { type: 'plain_text', value: token } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false },
  });
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  @page { size: A4 portrait; margin: 15mm; }
  body { margin: 0; font: 16px "Noto Sans TC"; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0; text-align: right; }
</style></head><body>
<table data-gt="full-width"><tr><td>EDGE</td></tr></table>
</body></html>`;

// Regression: changing only the PDF page box leaves Paged.js content at the
// document's portrait width, so the right-aligned marker never crosses x=595pt.
test.each(['portrait', 'landscape'] as const)(
  '%s request controls full-width table layout despite portrait @page CSS',
  async orientation => {
    const response = await worker.fetch(
      new URL('/print', (await worker.url).href),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ html, page: { size: 'A4', orientation } }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/pdf\b/i,
    );
    const pdf = await getDocumentProxy(
      new Uint8Array(await response.arrayBuffer()),
    );
    try {
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1);
      const { items } = await page.getTextContent();
      const markers = items.filter(
        item => 'str' in item && item.str === 'EDGE',
      );
      expect(markers).toHaveLength(1);
      const marker = markers[0];
      if (!marker || !('str' in marker)) {
        throw new Error('Expected EDGE text in the printed PDF');
      }
      const x = marker.transform[4];
      expect(x).toBeGreaterThan(0);
      if (orientation === 'landscape') {
        expect(
          x,
          'landscape content must extend beyond portrait page width',
        ).toBeGreaterThan(595);
      } else {
        expect(x + marker.width).toBeLessThan(595);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);
