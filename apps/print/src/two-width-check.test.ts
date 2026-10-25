import { Buffer } from 'node:buffer';
import { apiErrorSchema, gtSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'two-width-local-test';
const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
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
  target?: string;
  files?: Record<string, string>;
};

async function post(fixture: Fixture) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html><head><style>
        @page { size: A4; margin: 20mm; }
        body { margin: 0; }
        .target { width: 40px; height: 40px; background: black; }
        </style>${fixture.head ?? ''}</head><body>${fixture.target ?? '<div class="target" data-gt="image"></div>'}</body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'two-width',
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

// Print-only rules isolate the floor/ceil bracket from the screen comparison.
// Size overrides use div.target because Paged.js reinserts the base .target
// sheet after ignored styles; equal specificity would leave its 40px sizes.
const printRefusals: Fixture[] = [
  {
    name: 'equal-size image siblings swap boxes without changing the box multiset',
    head: `<style data-pagedjs-ignore>
      .pair { display: flex; width: 80px; }
      .red { background: red; } .blue { background: blue; }
      @media print and (min-width: 793.5px) {
        .red { transform: translateX(40px); }
        .blue { transform: translateX(-40px); }
      }
      </style>`,
    target: `<div class="pair"><div class="target red" data-gt="image"></div><div class="target blue" data-gt="image"></div></div>`,
  },
  {
    name: 'table cell widths change while the outer table box stays fixed',
    head: `<style data-pagedjs-ignore>
      table { table-layout: fixed; width: 400px; border-collapse: collapse; }
      td { height: 40px; padding: 0; }
      td:first-child { width: 100px; }
      @media print and (min-width: 793.5px) {
        td:first-child { width: 200px; }
      }
      </style>`,
    // Empty colored cells isolate geometry from PDF text extraction/merging.
    target:
      '<table data-gt="table"><tbody><tr><td style="background:red"></td><td style="background:blue"></td></tr></tbody></table>',
  },
  {
    name: 'unmarked descendant becomes fixed only at the ceil print viewport',
    head: `<style data-pagedjs-ignore>
      .ink { width: 10px; height: 10px; background: red; }
      @media print and (min-width: 793.5px) {
        .ink { position: fixed; left: 200px; top: 200px; }
      }
      </style>`,
    target: '<div class="target" data-gt="image"><div class="ink"></div></div>',
  },
  {
    name: 'vw changes a printed box continuously between adjacent widths',
    head: '<style data-pagedjs-ignore>@media print { div.target { width: 50vw; } }</style>',
  },
  ...['794px', '793.5px'].map(threshold => ({
    name: `print media threshold ${threshold} changes a box inside the A4 bracket`,
    head: `<style data-pagedjs-ignore>@media print and (min-width: ${threshold}) {
      .target { transform: translateX(100px); }
      }</style>`,
  })),
  {
    name: 'root container query moves a printed box across the A4 bracket',
    head: `<style data-pagedjs-ignore>
      html { container-type: inline-size; }
      @media print { @container (min-width: 793.5px) {
        .target { transform: translateX(100px); }
      } }
      </style>`,
  },
  {
    name: 'vh changes a printed box between adjacent heights',
    head: '<style data-pagedjs-ignore>@media print { div.target { height: 10vh; } }</style>',
  },
  {
    name: 'print-only late import is loaded before comparing boxes',
    head: '<style data-pagedjs-ignore media="print">@import url(outer.css);</style>',
    files: {
      'outer.css': '@import url(inner.css);',
      'inner.css':
        '@media (min-width: 793.5px) { .target { transform: translateX(100px); } }',
    },
  },
];

async function expectBracket(
  response: Response,
  kind: string,
  sizes: string[],
  allowFixedDetail = false,
) {
  expect(
    response.status,
    response.status === 200
      ? 'unsafe document printed successfully'
      : await response.clone().text(),
  ).toBe(422);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('viewport_dependent');
  expect(error.details?.length).toBeGreaterThan(0);
  for (const detail of error.details ?? []) {
    if (allowFixedDetail && /position:\s*fixed/.test(detail.message)) continue;
    expect(detail.message).toContain(kind);
    for (const size of sizes) expect(detail.message).toContain(size);
    // Diagnostics identify actual changed boxes, not the CSS mechanism.
    expect(detail.message).toMatch(
      /\d+ -?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/,
    );
  }
}

test.each(printRefusals)(
  'POST /print refuses $name with print bracket boxes and sizes',
  async fixture => {
    await expectBracket(await post(fixture), 'print media', [
      '793x1122',
      '794x1123',
    ]);
  },
);

test('POST /print refuses a ceil-only page transform even when all page-relative boxes stay unchanged', async () => {
  const response = await post({
    name: 'ceil-only page transform',
    head: `<style data-pagedjs-ignore>
      @media print and (min-width: 793.5px) {
        .pagedjs_page { transform: translateX(-40px) !important; }
      }
      </style>`,
    target: '<p data-gt="paragraph">Page frame regression</p>',
  });
  // Moving the page and its descendants together cancels out of page-relative
  // boxes, while Chromium prints the text 30pt left of its GT coordinates.
  expect(response.status, 'unsafe page frame printed successfully').toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(['page_box_moved', 'viewport_dependent']).toContain(error.code);
  const details = (error.details ?? [])
    .map(detail => detail.message)
    .join('\n');
  expect(details).toMatch(/page\s+1\b/i);
  expect(details).toContain('.pagedjs_page');
});

test('POST /print refuses an aspect-ratio image transform missed by both diagonal print samples', async () => {
  // 793/1122 and 794/1123 are below this threshold, but both the exact
  // Chromium print size and the mixed 794/1122 corner are above it.
  const response = await post({
    name: 'mixed-corner image transform',
    head: `<style data-pagedjs-ignore>
      @media print and (min-aspect-ratio: 70705/100000) {
        .target { transform: translateX(100px) !important; }
      }
      </style>`,
  });
  await expectBracket(response, 'print media', ['793x1122', '794x1122']);
});

test('POST /print refuses an aspect-ratio page transform missed by both diagonal print samples', async () => {
  const response = await post({
    name: 'mixed-corner page transform',
    head: `<style data-pagedjs-ignore>
      @media print and (min-aspect-ratio: 70705/100000) {
        .pagedjs_page { transform: translateX(-40px) !important; }
      }
      </style>`,
    target: '<p data-gt="paragraph">Mixed corner page frame regression</p>',
  });
  // The page-relative boxes stay equal even though the PDF text moves 30pt.
  expect(response.status, 'unsafe page frame printed successfully').toBe(422);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(['page_box_moved', 'viewport_dependent']).toContain(error.code);
  const details = (error.details ?? [])
    .map(detail => detail.message)
    .join('\n');
  expect(details).toMatch(/page\s+1\b/i);
  expect(details).toContain('.pagedjs_page');
});

test('POST /print refuses generated before pseudo-element fixed only at the ceil print viewport', async () => {
  const response = await post({
    name: 'ceil-only fixed pseudo-element',
    head: `<style data-pagedjs-ignore>
      div.target::before { content: ""; display: block; width: 10px; height: 10px; background: red; }
      @media print and (min-width: 793.5px) {
        div.target::before { position: fixed; left: 200px; top: 200px; }
      }
      </style>`,
  });
  // A pseudo-element has no element box: the retained fixed-position guard
  // may supply its existing diagnostic instead of a pair of changed boxes.
  await expectBracket(response, 'print media', ['793x1122', '794x1123'], true);
});

test('POST /print accepts a fixed-size multi-row table and nested unmarked image descendants', async () => {
  const response = await post({
    name: 'fixed-size table and nested descendants',
    head: `<style>
      table { table-layout: fixed; width: 100mm; border-collapse: collapse; }
      td { width: 50mm; height: 30px; padding: 0; }
      .outer { width: 20px; height: 20px; }
      .inner { width: 10px; height: 10px; background: red; }
      </style>`,
    target: `<table data-gt="table"><tbody>
      <tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr>
      </tbody></table>
      <div class="target" data-gt="image"><div class="outer"><div class="inner"></div></div></div>`,
  });
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const result = (await response.json()) as { pdf: string; gt: unknown };
  expect(Buffer.from(result.pdf, 'base64').subarray(0, 5).toString()).toBe(
    '%PDF-',
  );
  const gt = gtSchema.parse(result.gt);
  expect(gt.blocks.map(block => block.type)).toEqual(['table', 'image']);
});

test.each([
  {
    name: 'screen threshold at 795px is equal at 793/794 but different at pagination width',
    head: '<style data-pagedjs-ignore>@media screen and (min-width: 795px) { .target { transform: translateX(100px); } }</style>',
  },
  {
    name: 'screen vh height differs from the pagination viewport despite stable print boxes',
    head: '<style data-pagedjs-ignore>@media screen { div.target { height: 10vh; } }</style>',
  },
  {
    name: 'sizes changes intrinsic image width between pagination and page viewports',
    // A single raster candidate avoids candidate caching masking a sizes change.
    target: `<img data-gt="image" src="${pixel}" srcset="${pixel} 1w" sizes="(min-width: 795px) 200px, 40px">`,
  },
])(
  'POST /print refuses $name with pagination bracket boxes and sizes',
  async fixture => {
    await expectBracket(await post(fixture), 'pagination', [
      '800x600',
      '793x1122',
    ]);
  },
);

// Each control owns a removed denylist family; all measured boxes are fixed.
test.each<Fixture>([
  {
    name: 'unused viewport/container units and keyframes do not affect boxes',
    head: `<style>.target { --unused: 50vw; --height: 10vh; --container: 20cqw; }
      @keyframes unused { from { left: 50vw; } to { left: 0; } }</style>`,
  },
  {
    name: 'inactive size queries in style, link, import and grouped rules are harmless',
    head: `<style media="(min-width: 2000px)">.target { width: 200px; }</style>
      <link rel="stylesheet" media="(min-width: 2000px)" href="safe.css">
      <style data-pagedjs-ignore>@import url(safe.css) (min-width: 2000px);
      @media (min-width: 2000px) { .target { width: 200px; } }</style>`,
    files: { 'safe.css': '.target { width: 200px; }' },
  },
  {
    name: 'attr outside content in unused inline and linked custom properties is harmless',
    head: '<link rel="stylesheet" href="attr.css">',
    target:
      '<div class="target" data-gt="image" style="--unused: attr(data-width)"></div>',
    files: {
      'attr.css': '.target { --other: attr(data-width type(<length>), 50vw); }',
    },
  },
  {
    name: 'root size container with a constant matching query leaves boxes unchanged',
    head: `<style data-pagedjs-ignore>html { container-type: inline-size; }
      @container (min-width: 1px) { .target { width: 40px; } }</style>`,
  },
  {
    name: 'SVG viewport attribute units overridden by fixed CSS leave boxes unchanged',
    target:
      '<svg data-gt="image" width="50vw" height="10vh" style="width:40px;height:40px"><rect width="40" height="40"/></svg>',
  },
  {
    name: 'width-descriptor srcset and sizes with CSS-fixed image dimensions are harmless',
    target:
      '<picture><source srcset="pixel.svg 1000w" sizes="50vw"><img data-gt="image" src="pixel.svg" srcset="pixel.svg 1000w" sizes="50vw" style="width:40px;height:40px"></picture>',
    files: {
      'pixel.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    },
  },
])('POST /print accepts box-neutral CSS: $name', async fixture => {
  const response = await post(fixture);
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const result = (await response.json()) as { pdf: string; gt: unknown };
  expect(Buffer.from(result.pdf, 'base64').subarray(0, 5).toString()).toBe(
    '%PDF-',
  );
  expect(gtSchema.parse(result.gt).blocks).toHaveLength(1);
});
