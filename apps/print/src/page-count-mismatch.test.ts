import { readFileSync } from 'node:fs';
import { apiErrorSchema } from '@pdf-generator/contract';
import { getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'page-count-local-test-token';
const page = { size: 'A4', orientation: 'portrait' } as const;
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const image =
  '<div data-gt="image" style="width:40px;height:40px;background:black"></div>';

test.each([
  {
    name: 'a pack-supplied pagedjs-content template leaves an extra live body page',
    body: `<div style="height:10px;break-after:page"></div><template data-ref="pagedjs-content">${image}</template>`,
    css: '',
    source: {
      templateId: 'page-count',
      templateVersion: 1,
      seed: 'page-count',
      index: 0,
    },
  },
  {
    name: 'body padding adds a PDF sheet even without a ground-truth request',
    body: image,
    css: 'body { padding-top: 300mm; }',
    source: undefined,
  },
])('POST /print rejects $name with 422 page_count_mismatch', async fixture => {
  // Neither document has text: a guard conditional on expectedText misses
  // these extra sheets and returns a PDF whose page count disagrees with GT.
  const response = await fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html><head><style>@page { margin: 20mm; }
        body { margin: 0; } ${fixture.css}</style></head><body>${fixture.body}</body></html>`,
      page,
      ...(fixture.source ? { source: fixture.source } : {}),
    }),
  });
  let diagnostic: string | undefined;
  if (response.status === 200) {
    const bytes = fixture.source
      ? new Uint8Array(
          Buffer.from(
            ((await response.clone().json()) as { pdf: string }).pdf,
            'base64',
          ),
        )
      : new Uint8Array(await response.clone().arrayBuffer());
    const pdf = await getDocumentProxy(bytes);
    try {
      diagnostic = `PDF pages: ${pdf.numPages}; Paged.js pages: ${response.headers.get('x-page-count')}`;
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
  expect(response.status, diagnostic).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('page_count_mismatch');
});

test('renderPdf throws RenderError when the PDF has two pages but Paged.js reports one without text expectations', async () => {
  // HTTP can pin the error code/status, but cannot distinguish RenderError
  // from an unrelated exception translated by the route.
  const tab = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      pageCount: 1,
      unloadedFaces: [],
      fragmentedRows: [],
    })),
    pdf: vi.fn(
      async () =>
        new Uint8Array(
          readFileSync(
            new URL('./test-fixtures/blank-2-pages.pdf', import.meta.url),
          ),
        ),
    ),
    close: vi.fn(async () => {}),
  };
  const outcome = await renderPdf(
    fakeBrowserContext(tab).browser,
    { html: `<!doctype html><html><body>${image}</body></html>`, page },
    {
      assetOrigin: 'https://print-assets.example.test',
      store: { put: async () => {}, delete: async () => {} },
    },
  ).then(
    () => 'render unexpectedly succeeded',
    (error: unknown) => error,
  );
  expect.soft(outcome).toBeInstanceOf(RenderError);
  expect.soft(outcome).toMatchObject({ code: 'page_count_mismatch' });
  expect(tab.close).toHaveBeenCalledTimes(1);
});
