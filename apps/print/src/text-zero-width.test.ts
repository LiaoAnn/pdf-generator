// T07-30: the text check matched each data-gt text only inside its own client
// rects and skipped every text whose rects all have zero width. Chrome clamps
// a text's rect to zero width whenever its advance is zero or negative
// (negative letter-spacing or word-spacing), yet still paints the glyphs, so
// such text escaped the check: with visibility:hidden it printed nothing and
// the PDF still came out. Its glyphs can't be located from the DOM (each
// character's rect is offset from where the glyph is drawn), so the print is
// refused with text_zero_width. Text that prints nothing at all (only
// zero-width characters, a zero font size) stays skipped.
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { apiErrorSchema } from '@pdf-generator/contract';
import katex from 'katex';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'text-zero-width-local-test';
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
    if (!name.endsWith('.woff2')) continue;
    katexFiles[`fonts/${name}`] = (
      await readFile(join(dist, 'fonts', name))
    ).toString('base64');
  }
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function document(body: string, head = '') {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
${head}<style>
@page { size: A4; margin: 20mm; }
body { margin: 0; font: 16px/24px "Noto Sans TC"; }
</style></head><body><p data-gt="paragraph">前文照常印出。</p>${body}</body></html>`;
}

async function print(html: string, files?: Record<string, string>) {
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

test.each([
  {
    // The escape itself: -2em leaves a negative advance, the text's rect is
    // clamped to zero width, and visibility:hidden keeps it out of the PDF.
    name: 'hidden text squeezed by letter-spacing:-2em',
    markup:
      '<p data-gt="paragraph"><span style="letter-spacing:-2em;visibility:hidden">負寬藏字乙</span></p>',
    detail: 'page 1: 負寬藏字乙',
  },
  {
    name: 'visible CJK text squeezed by letter-spacing:-2em',
    markup:
      '<p data-gt="paragraph"><span style="letter-spacing:-2em">負寬文字丙</span></p>',
    detail: 'page 1: 負寬文字丙',
  },
  {
    // -1em cancels each CJK advance exactly: every glyph is drawn on one spot.
    name: 'visible CJK text squeezed by letter-spacing:-1em',
    markup:
      '<p data-gt="paragraph"><span style="letter-spacing:-1em">零寬文字甲</span></p>',
    detail: 'page 1: 零寬文字甲',
  },
  {
    // Zero-width characters among printing ones don't make it print nothing.
    name: 'squeezed text mixing letters and U+200B',
    markup:
      '<p data-gt="paragraph"><span style="letter-spacing:-2em">負​寬混字</span></p>',
    detail: 'page 1: 負​寬混字',
  },
  {
    name: 'Latin text squeezed by letter-spacing:-1em',
    markup:
      '<p data-gt="paragraph"><span style="letter-spacing:-1em">SQUEEZED</span></p>',
    detail: 'page 1: SQUEEZED',
  },
  {
    // On page 2: the detail names the page the text is on. Paged.js breaks
    // pages only for break-before in a stylesheet, not in a style attribute.
    name: 'text squeezed by negative word-spacing on page 2',
    markup:
      '<p data-gt="paragraph" class="next-page"><span style="word-spacing:-500px">AB CD EF</span></p>',
    head: '<style>.next-page { break-before: page; }</style>',
    detail: 'page 2: ABCDEF',
  },
  {
    // Not drawn, but laid out with zero width and a line's height: the DOM
    // can't tell it from squeezed text, so it is refused rather than skipped.
    name: 'text flattened by transform:scaleX(0)',
    markup:
      '<p data-gt="paragraph"><span style="display:inline-block;transform:scaleX(0)">壓扁文字丁</span></p>',
    detail: 'page 1: 壓扁文字丁',
  },
])('refuses $name as text_zero_width', async ({ markup, detail, head }) => {
  const response = await print(document(markup, head));
  expect(
    response.status,
    response.status === 200
      ? 'unexpected PDF success: zero-width data-gt text was skipped'
      : await response.clone().text(),
  ).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('text_zero_width');
  expect(error.details?.map(item => item.message)).toEqual([detail]);
});

test.each([
  {
    // KaTeX's .vlist-s holds U+200B; the others are default-ignorable too.
    name: 'a node of zero-width characters only',
    markup:
      '<p data-gt="paragraph">甲<span>\u200b\u2060\u00ad\ufeff</span>乙</p>',
  },
  {
    name: 'text at font-size 0',
    markup:
      '<p data-gt="paragraph">可見文字<span style="font-size:0">零號字</span></p>',
  },
])('prints $name, which prints nothing, as before', async ({ markup }) => {
  const response = await print(document(markup));
  expect(
    response.status,
    response.status === 200 ? '' : await response.clone().text(),
  ).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  await response.arrayBuffer();
});

// KaTeX overlays (\neq, \not), accents and its hidden MathML copy must not
// count as zero-width text: real formulas keep printing.
test('prints KaTeX formulas with overlays and accents', async () => {
  const formula = (tex: string) => katex.renderToString(tex);
  const response = await print(
    document(
      `<p data-gt="formula">${formula('a \\neq b')}，${formula('x \\not\\in A')}，${formula('\\vec{v} + \\hat{x} + \\bar{y}')}</p>`,
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
