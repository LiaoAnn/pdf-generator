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
const decoyCss = `.target::after { content: ""; position: absolute; top: 20mm;
  left: 0; width: 40px; height: 40px; background: black; }`;
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

async function post(
  html: string,
  source = false,
  requestPage: { size: 'A4'; orientation: 'portrait' | 'landscape' } = page,
) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: requestPage,
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
  // Regression: unchanged box properties can hide inner content displacement
  // caused by grid tracks, borders, or grid placement in screen media only.
  {
    name: 'screen-only pagebox grid tracks moving the area origin',
    css: decoyCss,
    head: `<style media="screen">body > div > div > div > div {
      grid-template-rows: [header] 40mm [page] 217mm [footer] 20mm !important;
    }</style>`,
  },
  {
    name: 'screen-only area border moving the content origin',
    css: decoyCss,
    head: `<style media="screen">body > div > div > div > div > div {
      border-top: 20mm solid transparent !important;
    }</style>`,
  },
  {
    name: 'screen-only area grid placement moving the content origin',
    css: `${decoyCss}
      body > div > div > div > div > div { grid-row: header !important; }`,
    head: `<style media="screen">html body > div > div > div > div > div {
      grid-row: page !important;
    }</style>`,
  },
  // Regression: container layout moves later pages without changing any box's
  // margin, padding, border, position, or transform; geometry must catch this.
  {
    name: 'screen-only flex gap displacing later pages without box property changes',
    css: `${decoyCss} section + section { break-before: page; }`,
    body: `<section>${image}</section><section>${image}</section><section>${image}</section>`,
    head: `<style media="screen">body > div {
      display: flex !important; flex-direction: column; gap: 10mm;
    }</style>`,
  },
])('POST /print rejects $name with 422 page_box_moved', async fixture => {
  const response = await post(
    document(fixture.css, fixture.body ?? image, fixture.head),
    fixture.source,
  );
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('page_box_moved');
});

// Regression: excess document width shrinks the PDF without moving the DOM
// boxes compared by the guard. The pseudo-element leaves ink at the GT box
// even after scaling, so the ink self-check alone accepts the wrong geometry.
test.each([
  {
    name: 'a generated page widened to 1300px triggers Chromium shrink-to-fit',
    css: 'body > div > div { width: 1300px !important; }',
  },
  {
    name: 'html min-width of 1300px triggers Chromium shrink-to-fit',
    css: 'html { min-width: 1300px; }',
  },
  // Regression: columns overflow only during Chrome's print layout, leaving
  // the screen and print DOM guard measurements unchanged.
  {
    name: 'container columns shrink a text-free page despite decoy ink',
    css: 'body > div { columns: 2; column-gap: 0; }',
  },
  {
    // A drawing-only scale check must also reject a scaled text layer.
    // Leave the paragraph unmarked so text_missing cannot mask the scale bug.
    name: 'container columns shrink a page containing ordinary Chinese text',
    css: 'body > div { columns: 2; column-gap: 0; }',
    body: '<div id="target" data-gt="image"></div><p>這是一份測試文件，確認列印比例與文字位置。</p>',
  },
  {
    // Default column balancing already trips the DOM guard on later pages.
    // Keep rejecting this multi-page document as PDF scale checks are added.
    name: 'container columns on three pages without other frame changes',
    css: `body > div { columns: 2; column-gap: 0; }
      section + section { break-before: page; }`,
    body: '<section><div id="target" data-gt="image"></div></section><section><div class="shrink-target" data-gt="image"></div></section><section><div class="shrink-target" data-gt="image"></div></section>',
  },
])('POST /print rejects $name with 422 page_box_moved', async fixture => {
  const response = await post(
    document(
      `html, body { margin: 0; padding: 0; }
      #target, .shrink-target { position: relative; width: 20px; height: 20px; background: black; }
      #target::after, .shrink-target::after { content: ""; position: absolute; left: 37.5px; top: 37.5px;
        width: 30px; height: 30px; background: black; }
      ${fixture.css}`,
      fixture.body ?? '<div id="target" data-gt="image"></div>',
    ),
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
  {
    // Regression: a fixed portrait-width limit rejects legitimate landscape pages.
    name: 'landscape A4 uses its own page width instead of portrait A4 width',
    html: document('@page { size: A4 landscape; }'),
    pages: 1,
    page: { size: 'A4', orientation: 'landscape' } as const,
  },
  {
    // SVG viewBox transforms are content scaling, not page shrink-to-fit.
    name: 'an inline SVG scales several paths beside ordinary text',
    html: document(
      '',
      `<svg data-gt="image" viewBox="0 0 200 100" width="100" height="50">
        <path d="M0 0H80V100H0Z" fill="black"/>
        <path d="M100 0L200 50L100 100Z" fill="blue"/>
        <path d="M10 10L70 90" stroke="red" stroke-width="4"/>
      </svg><p data-gt="paragraph">Normal page scale</p>`,
    ),
    pages: 1,
  },
  {
    // A nested CSS transform must not be mistaken for the page's PDF scale.
    name: 'a CSS scale(1.5) drawing beside unscaled text',
    html: document(
      '.target { transform: scale(1.5); transform-origin: top left; }',
      `${image}<p data-gt="paragraph">Normal page scale</p>`,
    ),
    pages: 1,
  },
  {
    // No text layer is available to distinguish image scaling from page scaling.
    // Use inline SVG: pack rules disallow data: image URLs.
    name: 'an image-only page with a scaled inline SVG',
    html: document(
      '',
      `<svg data-gt="image" viewBox="0 0 200 100" width="100" height="50">
        <path d="M0 0H200V100H0Z" fill="black"/>
        <path d="M20 20H180V80H20Z" fill="white"/>
      </svg>`,
    ),
    pages: 1,
  },
  {
    // An absent content drawing is not evidence of an invalid page scale.
    name: 'a page with no drawing beyond its background',
    html: document(
      '@page { background: #eeeeee; }',
      '<div style="height: 40px"></div>',
    ),
    pages: 1,
  },
])('POST /print accepts ordinary layout: $name', async fixture => {
  const response = await post(fixture.html, false, fixture.page ?? page);
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
