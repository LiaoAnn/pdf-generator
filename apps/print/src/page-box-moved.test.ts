import { readFileSync } from 'node:fs';
import { apiErrorSchema } from '@pdf-generator/contract';
import { getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'page-box-local-test-token';
const page = { size: 'A4', orientation: 'portrait' } as const;
const image = '<div data-gt="image" class="target"></div>';
const targetCss =
  '.target { position: relative; width: 40px; height: 40px; background: black; }';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

function document(css: string, body = image, head = '') {
  return `<!doctype html><html><head><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; }
    ${targetCss}
    ${css}
    </style>${head}</head><body>${body}</body></html>`;
}

async function post(html: string, source = false) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page,
      ...(source
        ? {
            source: {
              templateId: 'page-box',
              templateVersion: 1,
              seed: 'page-box',
              index: 0,
            },
          }
        : {}),
    }),
  });
}

// Regression: frame CSS can move every GT box while a text-free decoy
// supplies ink at its former PDF position; text/ink self-checks cannot guard it.
test.each([
  {
    name: 'generic negative margin with a text-free pseudo-element decoy',
    css: `body > div > div { margin-top: -20mm !important; }
      .target::after { content: ""; position: absolute; top: 20mm; left: 0;
        width: 40px; height: 40px; background: black; }`,
    source: true,
  },
  {
    name: 'explicit page negative margin',
    css: '.pagedjs_page { margin-top: -20mm !important; }',
  },
  {
    name: 'body horizontal padding without an extra sheet',
    css: 'body { padding-left: 10mm; }',
  },
  {
    name: 'generic sheet transform',
    css: 'body > div > div > div { transform: translateY(-20mm); }',
  },
  {
    name: 'page rotation with an unchanged bounding rectangle',
    css: 'body > div > div { rotate: 180deg; }',
  },
  {
    name: 'generic relative page offset',
    css: 'body > div > div { position: relative; top: -20mm; }',
  },
  {
    name: 'print-only shift hidden by a more specific screen override',
    css: 'body > div > div { margin-top: -20mm !important; }',
    head: '<style media="screen">html body > div > div { margin-top: 0 !important; }</style>',
  },
  ...[
    '.pagedjs_pages',
    '.pagedjs_pagebox',
    '.pagedjs_area',
    '.pagedjs_page_content',
  ].map(selector => ({
    name: `${selector} horizontal relative offset`,
    css: `${selector} { position: relative; left: -5mm; }`,
  })),
  {
    name: 'html horizontal negative margin without an extra sheet',
    css: 'html { margin-left: -10mm; }',
  },
])('POST /print rejects $name with 422 page_box_moved', async fixture => {
  const response = await post(
    document(fixture.css, image, fixture.head),
    fixture.source,
  );
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('page_box_moved');
});

// Regression: validating raw screen offsets or demanding identical page
// margins rejects Paged.js's legitimate defaults and page-specific geometry.
test.each([
  {
    name: 'three pages with 20mm margins and a reset body',
    html: document(
      'section + section { break-before: page; }',
      `<section>${image}</section><section>${image}</section><section>${image}</section>`,
    ),
    pages: 3,
  },
  {
    name: 'the browser default body margin',
    html: `<!doctype html><html><head><style>@page { margin: 20mm; }${targetCss}</style></head><body>${image}</body></html>`,
    pages: 1,
  },
  {
    name: 'running headers and different left/right page margins',
    html: document(
      `@page :left { margin-left: 25mm; margin-right: 15mm; }
    @page :right { margin-left: 15mm; margin-right: 25mm; }
    @page { @top-center { content: element(header); } }
    header { position: running(header); }
    section + section { break-before: page; }`,
      `<header>Running header</header><section>${image}</section><section>${image}</section><section>${image}</section>`,
    ),
    pages: 3,
  },
  { name: 'page padding', html: document('@page { padding: 5mm; }'), pages: 1 },
])('POST /print accepts ordinary layout: $name', async fixture => {
  const response = await post(fixture.html);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/application\/pdf/i);
  expect(response.headers.get('x-page-count')).toBe(String(fixture.pages));
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  const pdf = await getDocumentProxy(bytes);
  try {
    expect(pdf.numPages).toBe(fixture.pages);
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('renderPdf rejects moved-box diagnostics as RenderError and closes the tab', async () => {
  // HTTP cannot establish the typed error or cleanup of the caller-owned tab.
  const movedBoxes = ['page 1 .pagedjs_page margin-top: -75.6px'];
  const tab = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      pageCount: 1,
      unloadedFaces: [],
      fragmentedRows: [],
      movedBoxes,
    })),
    pdf: vi.fn(
      async () =>
        new Uint8Array(
          readFileSync(
            new URL('./test-fixtures/blank-1-pages.pdf', import.meta.url),
          ),
        ),
    ),
    close: vi.fn(async () => {}),
  };
  const outcome = await renderPdf(
    fakeBrowserContext(tab).browser,
    { html: document(''), page },
    {
      assetOrigin: 'https://print-assets.example.test',
      store: { put: async () => {}, delete: async () => {} },
    },
  ).then(
    () => 'render unexpectedly succeeded',
    (error: unknown) => error,
  );
  expect.soft(outcome).toBeInstanceOf(RenderError);
  expect
    .soft(outcome)
    .toMatchObject({ code: 'page_box_moved', details: movedBoxes });
  expect(tab.close).toHaveBeenCalledTimes(1);
});
