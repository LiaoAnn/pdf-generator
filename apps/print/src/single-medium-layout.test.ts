import { Buffer } from 'node:buffer';
import { apiErrorSchema, gtSchema } from '@pdf-generator/contract';
import { getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'single-medium-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

function document(
  head = '',
  body = '<p class="target" data-gt="paragraph"><span>MARKER</span></p>',
) {
  return `<!doctype html><html><head><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px sans-serif; }
    p { margin: 0; } .target { width: 50mm; }
    </style>${head}</head><body>${body}</body></html>`;
}

async function post(html: string, source = true, css?: string) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      ...(source
        ? {
            source: {
              templateId: 'single-medium',
              templateVersion: 1,
              seed: 'same',
              index: 0,
            },
          }
        : {}),
      ...(css === undefined
        ? {}
        : {
            pack: {
              template: 'index.html',
              files: { 'medium.css': Buffer.from(css).toString('base64') },
            },
          }),
    }),
  });
}

// Move the block but counter-move its text on screen: the PDF text guard
// still passes, exposing GT's wrong box rather than merely text_missing.
const shift = `.target { position: relative; left: 30mm; }
  .target span { position: relative; left: -30mm; }`;

test.each([
  {
    name: 'style media=screen',
    head: `<style media="screen">${shift}</style>`,
  },
  {
    name: 'ignored style with screen media',
    head: `<style data-pagedjs-ignore>@media screen { ${shift} }</style>`,
  },
  {
    name: 'linked screen stylesheet',
    head: '<link rel="stylesheet" media="screen" href="medium.css">',
    css: shift,
  },
  {
    name: 'linked ignored stylesheet',
    head: '<link rel="stylesheet" data-pagedjs-ignore href="medium.css">',
    css: `@media screen { ${shift} }`,
  },
  {
    name: 'all with viewport width feature',
    head: `<style>@media all and (min-width: 800px) { ${shift} }</style>`,
  },
])(
  'POST /print keeps GT at the PDF text position or refuses $name',
  async fixture => {
    const response = await post(document(fixture.head), true, fixture.css);
    if (response.status === 422) {
      apiErrorSchema.parse(await response.json());
      return;
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as { gt: unknown; pdf: string };
    const gt = gtSchema.parse(body.gt);
    const pdf = await getDocumentProxy(
      new Uint8Array(Buffer.from(body.pdf, 'base64')),
    );
    try {
      expect(gt.blocks).toHaveLength(1);
      const block = gt.blocks[0];
      if (!block) throw new Error('missing marker block');
      const page = await pdf.getPage(block.page);
      const { items } = await page.getTextContent();
      const text = items.find(item => 'str' in item && item.str === 'MARKER');
      if (!text || !('str' in text)) throw new Error('missing printed MARKER');
      expect(
        Math.abs(block.bbox[0] - text.transform[4]),
        'GT left edge must match printed text, within 1pt',
      ).toBeLessThan(1);
      const baseline = (page.view[3] ?? 0) - text.transform[5];
      expect(baseline).toBeGreaterThan(block.bbox[1]);
      expect(baseline).toBeLessThan(block.bbox[3]);
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);

test('ordinary content keeps its independently specified screen GT in print', async () => {
  const response = await post(document());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { gt: unknown };
  const gt = gtSchema.parse(body.gt);
  expect(gt.blocks).toHaveLength(1);
  const block = gt.blocks[0];
  if (!block) throw new Error('missing marker block');
  // 20mm page margin, 50mm block width, 24px line height; CSS px = .75pt.
  const expected = [
    (20 * 72) / 25.4,
    (20 * 72) / 25.4,
    (70 * 72) / 25.4,
    (20 * 72) / 25.4 + 18,
  ];
  for (const [i, actual] of block.bbox.entries()) {
    expect(Math.abs(actual - (expected[i] ?? 0))).toBeLessThan(0.1);
  }
});

test('text_missing ignores text displayed only on screen', async () => {
  const response = await post(
    document(
      '<style data-pagedjs-ignore media="print">.target { display: none; }</style>',
    ),
    false,
  );
  expect(response.status, await response.clone().text()).toBe(200);
});

test('row_fragmented ignores a row displaced outside its page only on screen', async () => {
  const response = await post(
    document(
      '<style media="screen">tr { position: relative; top: 300mm; }</style>',
      '<table data-gt="table"><tr><td>ROW</td></tr></table>',
    ),
    false,
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
});

test('row_fragmented rejects a row displaced outside its page only in print', async () => {
  const response = await post(
    document(
      '<style data-pagedjs-ignore media="print">tr { position: relative; left: 180mm; }</style>',
      '<table data-gt="table"><tr><td>ROW</td></tr></table>',
    ),
    false,
  );
  expect(response.status).toBe(422);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
    'row_fragmented',
  );
});

test('PDF scale check does not mistake a print-only content transform for page scaling', async () => {
  const response = await post(
    document(
      '<style data-pagedjs-ignore media="print">.target { transform: scale(1.5); transform-origin: top left; }</style>',
      '<div data-gt="image" class="target" style="width:40px;height:40px;background:black"></div>',
    ),
    false,
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
});
