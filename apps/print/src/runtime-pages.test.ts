import { gtSchema } from '@pdf-generator/contract';
import { checkPdf, readPdf } from '@pdf-generator/self-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'runtime-pages-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const compact = (text: string) => text.replace(/\s/g, '');
const slots = `<p data-gt="page_number"><span data-gt-page-number></span>
  / <span data-gt-page-count></span></p>`;
const sections = `<section><p data-gt="paragraph">Alpha</p></section>
  <section><div class="pagedjs_pages pack-pages">
    <div class="pagedjs_page pack-page">
      <p data-gt="paragraph">Beta</p>${slots}
    </div>
  </div></section>
  <section><p data-gt="paragraph">Gamma</p></section>`;

test.each([
  {
    name: 'nested look-alike pages do not overwrite page-2 slots or add text expectations for nonexistent pages',
    rootClasses: false,
    body: sections,
  },
  {
    name: 'runtime and GT agree on the last body container despite root classes and an earlier body container',
    rootClasses: true,
    // A pack-supplied content template leaves this earlier body child in
    // place when Paged.js appends the generated container. It is hidden so
    // it cannot itself add a PDF sheet or an out-of-page visible GT block.
    body: `<div class="pagedjs_pages decoy"><div class="pagedjs_page">
      <p data-gt="paragraph">Unprinted decoy</p>${slots}
    </div></div><template data-ref="pagedjs-content">${sections}</template>`,
  },
])('POST /print: $name', async fixture => {
  // This is also a behavioral synchronization guard for collect.js: the
  // runtime's per-page text guard and slots, the real collector's GT, and
  // the PDF must all agree with independently specified page membership.
  // Broadening either selector, choosing the first body container, or
  // including descendant pages breaks these assertions without coupling
  // the test to the spelling of either implementation.
  const response = await fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html lang="en" ${fixture.rootClasses ? 'class="pagedjs_pages"' : ''}>
        <head><meta charset="utf-8"><style>
          @page { margin: 20mm; }
          body { margin: 0; font: 16px/24px sans-serif; }
          html.pagedjs_pages, body.pagedjs_page {
            display: block; margin: 0; padding: 0; width: auto; height: auto;
          }
          section { height: 100mm; }
          section + section { break-before: page; }
          p { margin: 0; }
          .pack-pages { display: block; width: 300px; margin: 0; padding: 12px; }
          .pack-page {
            position: relative; width: 240px; height: 60px; margin: 0;
            padding: 6px; box-shadow: none; flex: none;
          }
          .decoy { display: none !important; }
        </style></head><body ${fixture.rootClasses ? 'class="pagedjs_page"' : ''}>
          ${fixture.body}
        </body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'runtime-pages',
        templateVersion: 1,
        seed: 'runtime-pages',
        index: 0,
      },
    }),
  });
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const body = (await response.json()) as {
    pageCount: number;
    pdf: string;
    gt: unknown;
  };
  const gt = gtSchema.parse(body.gt);
  const pdf = new Uint8Array(Buffer.from(body.pdf, 'base64'));
  const { pages } = await readPdf(pdf);
  expect(body.pageCount).toBe(3);
  expect(gt.pages).toHaveLength(3);
  expect(pages).toHaveLength(3);
  expect(
    gt.blocks
      .filter(block => block.type === 'page_number')
      .map(block => ({ page: block.page, text: compact(block.text) })),
  ).toEqual([{ page: 2, text: '2/3' }]);
  expect(
    gt.blocks
      .filter(block => block.type === 'paragraph')
      .map(block => ({ page: block.page, text: compact(block.text) })),
  ).toEqual([
    { page: 1, text: 'Alpha' },
    { page: 2, text: 'Beta' },
    { page: 3, text: 'Gamma' },
  ]);
  expect(
    pages.map(page => compact(page.items.map(item => item.text).join(''))),
  ).toEqual(['Alpha', 'Beta2/3', 'Gamma']);
  expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
});
