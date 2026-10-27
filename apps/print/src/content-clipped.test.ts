import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { apiErrorSchema } from '@pdf-generator/contract';
import katex from 'katex';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'content-clipped-local-test';
let worker: PrintWorker;
const katexFiles: Record<string, string> = {};
beforeAll(async () => {
  const dist = dirname(
    createRequire(import.meta.url).resolve('katex/dist/katex.min.css'),
  );
  katexFiles['katex.min.css'] = (
    await readFile(join(dist, 'katex.min.css'))
  ).toString('base64');
  for (const name of await readdir(join(dist, 'fonts'))) {
    if (name.endsWith('.woff2')) {
      katexFiles[`fonts/${name}`] = (
        await readFile(join(dist, 'fonts', name))
      ).toString('base64');
    }
  }
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

const box = '<div class="box" data-gt="image"></div>';
const ignored = (css: string) =>
  `<style data-pagedjs-ignore>@media print { ${css} }</style>`;
function document(body: string, css = '', head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px "Noto Sans TC"; }
    .wrapper { width: 100px; height: 40px; }
    .box { width: 80px; height: 90px; background: black; }
    ${css}</style>${head}</head><body>${body}</body></html>`;
}
async function post(html: string, files?: Record<string, string>) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      ...(files ? { pack: { template: 'index.html', files } } : {}),
    }),
  });
}
async function expectError(response: Response, page: number) {
  expect(
    response.status,
    response.status === 200
      ? 'unexpected PDF success'
      : await response.clone().text(),
  ).toBe(422);
  expect(response.headers.has('x-page-count')).toBe(false);
  expect(response.headers.get('content-type')).not.toMatch(/application\/pdf/);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('content_clipped');
  expect(
    error.details?.some(detail =>
      new RegExp(`page ${page}\\b`).test(detail.message),
    ),
    JSON.stringify(error.details),
  ).toBe(true);
}

// Textless ink rules out text_missing as an accidental reason for refusal.
test.each([
  {
    name: 'a taller data-gt box in overflow:hidden',
    css: '.wrapper { overflow: hidden; }',
  },
  {
    name: 'a wider data-gt box in overflow-x:clip',
    css: '.wrapper { overflow-x: clip; } .box { width: 150px; height: 20px; }',
  },
  { name: 'an overflow:auto ancestor', css: '.wrapper { overflow: auto; }' },
  {
    name: 'an overflow:scroll ancestor',
    css: '.wrapper { overflow: scroll; }',
  },
  { name: 'a contain:paint ancestor', css: '.wrapper { contain: paint; }' },
  {
    name: 'a clip-path ancestor',
    css: '.wrapper { height: 100px; clip-path: inset(0 0 50px 0); }',
  },
])(
  'refuses $name instead of describing unprinted ink in ground truth',
  async ({ css }) => {
    await expectError(
      await post(document(`<div class="wrapper">${box}</div>`, css)),
      1,
    );
  },
);

test('refuses a textless descendant clipped inside its own data-gt block', async () => {
  await expectError(
    await post(
      document(
        '<div data-gt="image" style="width:100px;height:100px"><div class="wrapper" style="overflow:hidden"><span style="display:block;width:80px;height:90px;background:black"></span></div></div>',
      ),
    ),
    1,
  );
});

test.each([
  {
    name: 'a data-gt box inside a pack wrapper named katex-mathml',
    body: '<div class="katex-mathml" style="width:100px;height:30px;overflow:hidden"><div data-gt="image" style="width:100px;height:100px;background:black"></div></div>',
  },
  {
    name: 'a textless descendant inside a non-formula block with a clipping katex-mathml wrapper',
    body: '<div data-gt="image" style="width:100px;height:100px"><div class="katex-mathml" style="width:100px;height:30px;overflow:hidden"><div style="width:100px;height:100px;background:black"></div></div></div>',
  },
  {
    name: 'a data-gt box itself named katex-mathml',
    body: '<div style="width:100px;height:30px;overflow:hidden"><div class="katex-mathml" data-gt="image" style="width:100px;height:100px;background:black"></div></div>',
  },
])('refuses clipping of $name', async ({ body }) => {
  await expectError(await post(document(body)), 1);
});

test.each([
  { side: 'top', offset: 'top:-20px' },
  { side: 'left', offset: 'left:-20px' },
])('refuses a data-gt box clipped at the $side', async ({ side, offset }) => {
  // Keep even the unclipped box inside the page content area, so page bounds
  // cannot account for the refusal. Relative positioning avoids margin collapse.
  const body = `<div style="margin:40px;width:100px;height:40px;overflow:hidden"><div data-gt="image" style="position:relative;${offset};width:80px;height:40px;background:black"></div></div>`;
  const control = await post(
    document(body.replace('overflow:hidden', 'overflow:visible')),
  );
  expect(
    control.status,
    control.status === 200 ? '' : await control.clone().text(),
  ).toBe(200);
  await control.arrayBuffer();

  const response = await post(document(body));
  const details = response.clone();
  await expectError(response, 1);
  const { error } = apiErrorSchema.parse(await details.json());
  expect(
    error.details?.some(detail => detail.message.includes(`at the ${side}`)),
    JSON.stringify(error.details),
  ).toBe(true);
});

test('clipping on the second page reports page 2 rather than the first page', async () => {
  const body = `<section><div style="height:20px;background:black" data-gt="image"></div></section><section><div class="wrapper">${box}</div></section>`;
  const pagination = 'section + section { break-before: page; }';
  // First establish that the same layout really puts the target on page 2.
  const control = await post(document(body, pagination));
  expect(
    control.status,
    control.status === 200 ? '' : await control.clone().text(),
  ).toBe(200);
  expect(control.headers.get('x-page-count')).toBe('2');
  await control.arrayBuffer();
  await expectError(
    await post(document(body, `${pagination} .wrapper { overflow:hidden; }`)),
    2,
  );
});

test.each([
  {
    name: 'an ignored print stylesheet enables ancestor clipping',
    css: '.wrapper { overflow: visible; }',
    head: ignored('body .wrapper.wrapper { overflow: hidden !important; }'),
    prefix: '',
  },
  {
    name: 'an ignored print stylesheet grows content in a clipping ancestor',
    css: '.wrapper { overflow: hidden; } .box { height: 20px; }',
    head: ignored('body .box.box { height: 90px !important; }'),
    prefix: '',
  },
  {
    name: 'a body print stylesheet enables ancestor clipping',
    css: '.wrapper { overflow: visible; }',
    head: '',
    prefix:
      '<style>@media print { body .wrapper.wrapper { overflow: hidden !important; } }</style>',
  },
])('refuses clipping when $name', async ({ css, head, prefix }) => {
  // Removing the override must leave a printable control; specificity above
  // ensures Paged.js cannot silently override the intended print-only change.
  const control = await post(
    document(`<div class="wrapper">${box}</div>`, css),
  );
  expect(
    control.status,
    control.status === 200 ? '' : await control.clone().text(),
  ).toBe(200);
  await control.arrayBuffer();
  await expectError(
    await post(
      document(`${prefix}<div class="wrapper">${box}</div>`, css, head),
    ),
    1,
  );
});

test.each([
  { name: 'ordinary content', body: box, css: '' },
  {
    name: 'a box fully inside an overflow:hidden wrapper',
    body: `<div class="wrapper">${box}</div>`,
    css: '.wrapper { overflow:hidden; } .box { height:20px; }',
  },
  {
    name: 'absolute content whose containing block is outside the clipping wrapper',
    body: `<div style="position:relative;height:100px"><div class="wrapper">${box}</div></div>`,
    css: '.wrapper { overflow:hidden; } .box { position:absolute; top:0; left:0; }',
  },
  {
    name: 'clipping applied only on screen',
    body: `<div class="wrapper">${box}</div>`,
    css: '@media screen { .wrapper { overflow:hidden; } }',
  },
  {
    name: 'an SVG intentionally clipping its own drawing to its viewBox',
    body: '<svg data-gt="image" width="100" height="100" viewBox="0 0 100 100"><circle cx="90" cy="50" r="40" fill="black"/></svg>',
    css: '',
  },
])('still prints $name', async ({ body, css }) => {
  const response = await post(document(body, css));
  expect(
    response.status,
    response.status === 200 ? '' : await response.clone().text(),
  ).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  await response.arrayBuffer();
});

test('KaTeX hidden 1px MathML copy does not count as clipped formula content', async () => {
  const response = await post(
    document(
      `<div data-gt="formula">${katex.renderToString('x^2 + y^2 = r^2', { displayMode: true })}</div>`,
      '',
      '<link rel="stylesheet" href="katex.min.css">',
    ),
    katexFiles,
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.clone().text(),
  ).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  await response.arrayBuffer();
});

test('a long paragraph split across two Paged.js pages is not ancestor clipping', async () => {
  const response = await post(
    document(
      `<p data-gt="paragraph" style="margin:0;line-height:24px">${'一二三四五六七八九十。'.repeat(250)}</p>`,
    ),
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.clone().text(),
  ).toBe(200);
  expect(response.headers.get('x-page-count')).toBe('2');
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  await response.arrayBuffer();
});
