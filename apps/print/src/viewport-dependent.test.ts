import { Buffer } from 'node:buffer';
import { apiErrorSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'viewport-dependent-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

type Fixture = {
  name: string;
  head?: string;
  body?: string;
  files?: Record<string, string>;
  diagnostic: string;
};

async function post(fixture: Omit<Fixture, 'name' | 'diagnostic'>) {
  const html = `<!doctype html><html><head><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px sans-serif; }
    .target { width: 50mm; margin: 0; }
    </style>${fixture.head ?? ''}</head><body>
    <p class="target" data-gt="paragraph">VIEWPORT_GUARD_MARKER</p>
    ${fixture.body ?? ''}</body></html>`;
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'viewport-guard',
        templateVersion: 1,
        seed: 'same',
        index: 0,
      },
      ...(fixture.files
        ? {
            pack: {
              template: 'index.html',
              files: Object.fromEntries(
                Object.entries(fixture.files).map(([path, contents]) => [
                  path,
                  Buffer.from(contents).toString('base64'),
                ]),
              ),
            },
          }
        : {}),
    }),
  });
}

const rule = '.target { width: 50vw; }';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

// Each row isolates a bypass: detecting another unit or another source cannot
// make this row pass. The declarations deliberately keep the page printable.
const refusals: Fixture[] = [
  ...[
    'vw',
    'vh',
    'vi',
    'vb',
    'vmin',
    'vmax',
    'svw',
    'svh',
    'svi',
    'svb',
    'svmin',
    'svmax',
    'lvw',
    'lvh',
    'lvi',
    'lvb',
    'lvmin',
    'lvmax',
    'dvw',
    'dvh',
    'dvi',
    'dvb',
    'dvmin',
    'dvmax',
    'cqw',
    'cqh',
    'cqi',
    'cqb',
    'cqmin',
    'cqmax',
    'Vw',
  ].map(unit => ({
    name: `${unit} length in a stylesheet declaration`,
    head: `<style>.target { width: 1${unit}; }</style>`,
    diagnostic: `1${unit}`,
  })),
  ...[
    ['head style', `<style>${rule}</style>`, ''],
    ['body style', '', `<style>${rule}</style>`],
    ['screen-only style', `<style media="screen">${rule}</style>`, ''],
    [
      'Paged.js ignored style',
      `<style data-pagedjs-ignore>${rule}</style>`,
      '',
    ],
    ['nested media rule', `<style>@media print { ${rule} }</style>`, ''],
    [
      'supports group',
      `<style>@supports (display: block) { ${rule} }</style>`,
      '',
    ],
    ['layer group', `<style>@layer pack { ${rule} }</style>`, ''],
    ['CSS nesting', '<style>.target { & span { width: 50vw; } }</style>', ''],
    ['page rule', '<style>@page { margin-left: 1vw; }</style>', ''],
    [
      'keyframes',
      '<style>@keyframes unused { from { left: 50vw; } to { left: 0; } }</style>',
      '',
    ],
    ['custom property', '<style>.target { --unused-width: 50vw; }</style>', ''],
    ['style attribute', '', '<div style="width: 50vw"></div>'],
    [
      'SVG presentation attribute',
      '',
      '<svg width="100" height="10"><rect width="50vw" height="10"/></svg>',
    ],
  ].map(([name, head, body]) => ({
    name: name ?? '',
    head,
    body,
    diagnostic: name === 'page rule' ? '1vw' : '50vw',
  })),
  ...[
    ['head linked stylesheet', '<link rel="stylesheet" href="sheet.css">', ''],
    ['body linked stylesheet', '', '<link rel="stylesheet" href="sheet.css">'],
    [
      'screen-only linked stylesheet',
      '<link rel="stylesheet" media="screen" href="sheet.css">',
      '',
    ],
    [
      'Paged.js ignored linked stylesheet',
      '<link rel="stylesheet" data-pagedjs-ignore href="sheet.css">',
      '',
    ],
  ].map(([name, head, body]) => ({
    name: name ?? '',
    head,
    body,
    files: { 'sheet.css': rule },
    diagnostic: '50vw',
  })),
  {
    name: 'transitively imported stylesheet',
    head: '<link rel="stylesheet" href="outer.css">',
    files: { 'outer.css': '@import "inner.css";', 'inner.css': rule },
    diagnostic: '50vw',
  },
  ...[
    '(width: 800px)',
    '(min-width: 800px)',
    '(max-width: 800px)',
    '(height: 1000px)',
    '(min-height: 1000px)',
    '(max-height: 1000px)',
    '(aspect-ratio: 4/3)',
    '(min-aspect-ratio: 4/3)',
    '(max-aspect-ratio: 4/3)',
    '(orientation: portrait)',
    '(device-width: 800px)',
    '(min-device-width: 800px)',
    '(max-device-height: 1000px)',
    '(device-aspect-ratio: 4/3)',
    '(width >= 800px)',
    '(400px < width < 900px)',
    '(HEIGHT <= 1000px)',
  ].map(query => ({
    name: `viewport media query ${query}`,
    // Paged.js cannot parse range syntax; Chrome can. Ignored sheets must
    // still be inspected, without making this a pagination-parser test.
    head: `<style${/[<>=]/.test(query) ? ' data-pagedjs-ignore' : ''}>@media ${query} { .target { color: black; } }</style>`,
    // Whitespace/case normalization is allowed; require the identifying feature.
    diagnostic: /aspect-ratio/i.test(query)
      ? 'aspect-ratio'
      : /orientation/i.test(query)
        ? 'orientation'
        : /height/i.test(query)
          ? 'height'
          : 'width',
  })),
  {
    name: 'style media attribute size query',
    head: '<style media="print and (min-width: 1px)">.target { color: black; }</style>',
    diagnostic: 'min-width',
  },
  {
    name: 'link media attribute size query',
    head: '<link rel="stylesheet" media="(orientation: landscape)" href="safe.css">',
    files: { 'safe.css': '.target { color: black; }' },
    diagnostic: 'orientation',
  },
  {
    name: 'import media list size query',
    head: '<style>@import "safe.css" print and (min-width: 1px);</style>',
    files: { 'safe.css': '.target { color: black; }' },
    diagnostic: 'min-width',
  },
  {
    name: 'typed attr in a property',
    body: '<div data-width="50vw" style="width: attr(data-width type(<length>), 1px)"></div>',
    diagnostic: 'attr(',
  },
  {
    name: 'attr in an unused custom property',
    head: '<style>.target { --unused-width: attr(data-width); }</style>',
    diagnostic: 'attr(',
  },
  {
    name: 'attr in a stylesheet property',
    head: '<style>.target { width: attr(data-width type(<length>), 10px); }</style>',
    diagnostic: 'attr(',
  },
  ...['img', 'source'].map(tag => ({
    name: `${tag} sizes viewport length`,
    body:
      tag === 'img'
        ? '<img src="pixel.svg" sizes="50vw" width="10" height="10">'
        : '<picture><source srcset="pixel.svg" sizes="50vw"><img src="pixel.svg" width="10" height="10"></picture>',
    files: { 'pixel.svg': svg },
    diagnostic: '50vw',
  })),
  {
    name: 'sizes viewport media query with fixed lengths',
    body: '<img src="pixel.svg" sizes="(max-width: 800px) 10px, 20px" width="10" height="10">',
    files: { 'pixel.svg': svg },
    diagnostic: 'max-width',
  },
];

test.each(refusals)(
  'POST /print refuses $name with actionable viewport_dependent diagnostics',
  async fixture => {
    const response = await post(fixture);
    expect(
      response.status,
      response.status === 200
        ? 'unsafe document printed successfully'
        : await response.clone().text(),
    ).toBe(422);
    expect(response.headers.has('x-page-count')).toBe(false);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('viewport_dependent');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.details?.length).toBeGreaterThan(0);
    expect(
      error.details?.some(detail =>
        detail.message.toLowerCase().includes(fixture.diagnostic.toLowerCase()),
      ),
      JSON.stringify(error.details),
    ).toBe(true);
  },
);

// Regression: scanning raw HTML/CSS tokens instead of values refuses innocent
// strings, asset names, content attr(), and fixed or font-relative dimensions.
const controls: Omit<Fixture, 'diagnostic'>[] = [
  {
    name: 'CSS strings and comments containing forbidden-looking tokens',
    head: `<style>/* 50vw; @media (min-width: 1px); attr(data-w) */
      .target::after { content: "50vw 1dvh 1cqw attr(data-w) (min-width: 1px)"; }
      .target { --label: "50vw"; }</style>`,
  },
  {
    name: 'url filenames containing viewport units and attr tokens',
    head: '<style>.target { background-image: url("50vw-attr(fake).svg"), url(50vw.svg); }</style>',
    files: { '50vw-attr(fake).svg': svg, '50vw.svg': svg },
  },
  {
    name: 'attr in content and ordinary HTML attributes',
    head: '<style>.target::after { content: attr(data-label); }</style>',
    body: '<div data-width="50vw" title="50vw attr(data-w)"></div>',
  },
  {
    name: 'px mm percent em rem and ch lengths',
    head: '<style>.target { width: 50mm; max-width: 100%; padding: 1px; margin-left: 1em; font-size: 1rem; text-indent: 1ch; }</style>',
  },
  {
    name: 'plain print and screen media rules and attributes',
    head: `<style media="screen">.target { color: black; }</style>
      <style data-pagedjs-ignore>@media print { .target { color: black; } } @media screen { .target { color: black; } }</style>
      <link rel="stylesheet" media="print" href="safe.css">`,
    files: { 'safe.css': '@media print { .target { color: black; } }' },
  },
  {
    name: 'import with a plain print media list',
    head: '<style>@import "safe.css" print;</style>',
    files: { 'safe.css': '.target { color: black; }' },
  },
  {
    name: 'fixed SVG dimensions and fixed image sizes',
    body: '<svg width="10" height="10"><rect width="10" height="10"/></svg><img src="pixel.svg" sizes="10px" width="10" height="10">',
    files: { 'pixel.svg': svg },
  },
];

test.each(controls)(
  'POST /print accepts viewport-independent control: $name',
  async fixture => {
    const response = await post(fixture);
    expect(
      response.status,
      response.status === 200 ? '' : await response.text(),
    ).toBe(200);
    const body = (await response.json()) as {
      pdf: string;
      gt: { blocks: unknown[] };
    };
    expect(Buffer.from(body.pdf, 'base64').subarray(0, 5).toString()).toBe(
      '%PDF-',
    );
    expect(body.gt.blocks.length).toBeGreaterThan(0);
  },
);
