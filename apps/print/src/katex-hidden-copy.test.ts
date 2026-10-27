import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { apiErrorSchema } from '@pdf-generator/contract';
import katex from 'katex';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'katex-hidden-copy-local-test';
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
</style></head><body>${body}</body></html>`;
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

// visibility:hidden preserves text ranges and layout but omits the PDF ink.
// There is no clipping ancestor or KaTeX CSS in these packs: content_clipped
// must not substitute for the missing-text refusal being tested.
test.each([
  {
    name: 'an HTML span named katex-mathml',
    text: '遺漏文字甲',
    copy: '<span class="katex-mathml" style="visibility:hidden">遺漏文字甲</span>',
  },
  {
    name: 'pack-authored MathML in a visible katex-mathml wrapper',
    text: '遺漏文字乙',
    copy: '<span class="katex-mathml"><math><mtext style="visibility:hidden">遺漏文字乙</mtext></math></span>',
  },
  {
    name: 'MathML text overflowing a CSS-sized 1px element in katex-mathml',
    text: '遺漏文字丙',
    // The observer sees a 1x1 mtext box even though its text range extends
    // beyond it. A box-size-only hidden-copy exemption would miss this text.
    copy: '<span class="katex-mathml"><math><mtext style="display:block;width:1px;height:1px;visibility:hidden">遺漏文字丙</mtext></math></span>',
  },
])(
  'requires unprinted text from $name as text_missing',
  async ({ copy, text }) => {
    const response = await print(
      document(`<p data-gt="paragraph">檢查內容：${copy}</p>`),
    );
    expect(
      response.status,
      response.status === 200
        ? 'unexpected PDF success: katex-mathml text was skipped'
        : await response.clone().text(),
    ).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('text_missing');
    expect(error.details?.map(detail => detail.message)).toContain(
      `page 1: ${text}`,
    );
  },
);

const paintRegressions = [
  {
    name: 'text-shadow paints an offscreen MathML copy inside the clip',
    text: 'SHADOW',
    css: '.clip { display:block; width:200px; height:60px; overflow:hidden } math { display:block; position:relative; left:-200px; width:180px } mtext { text-shadow:210px 0 black; font:24px sans-serif }',
  },
  {
    name: 'vertical ink overflows a CSS-sized one-pixel token',
    text: 'VERTICAL',
    css: '.clip { display:block; height:100px; overflow:hidden } math { display:block; width:180px; height:20px } mtext { display:block; width:180px; height:1px; position:relative; top:-10px; font:30px/100px sans-serif }',
  },
  {
    name: 'first-line shadow escapes the token box',
    text: 'FIRSTLINE',
    css: '.clip { display:block; width:200px; height:60px; overflow:hidden } math { display:block; position:relative; left:-200px; width:180px } p::first-line { text-shadow:210px 0 black }',
  },
  {
    name: 'italic glyph overhang paints inside a large clip despite an outside MathML box',
    text: 'f',
    css: '.clip { display:block; position:relative; width:200px; height:180px; overflow:hidden } math { position:relative; left:-35px } mtext { font:italic 100px serif }',
  },
  ...[
    {
      name: 'static wrapper does not seal overflowing MathML',
      css: 'position:static',
    },
    {
      name: 'relative wrapper does not seal overflowing MathML',
      css: 'position:relative',
    },
    {
      name: 'visible horizontal overflow does not seal the wrapper',
      css: 'overflow-x:visible',
    },
    {
      name: 'visible vertical overflow does not seal the wrapper',
      css: 'overflow-y:visible',
    },
    {
      name: 'overflow clip margin permits ink beyond the wrapper',
      css: 'overflow:clip;overflow-clip-margin:20px',
    },
    {
      name: 'two-pixel wrapper exceeds the hidden-copy limit',
      css: 'width:2px',
    },
    {
      name: 'wrapper transform enlarges its one-pixel clip',
      css: 'transform:scale(50);transform-origin:top left',
    },
    {
      name: 'ancestor transform enlarges the one-pixel clip',
      css: '',
      ancestor:
        '.ancestor { transform:scale(50);transform-origin:top left;display:inline-block;width:1px;height:1px }',
    },
    {
      name: 'display contents has no sealing wrapper box',
      css: 'display:contents',
    },
    {
      name: 'inline wrapper does not seal its content',
      css: 'position:static;display:inline',
    },
    {
      name: 'fixed-position descendant prevents the wrapper exemption',
      css: '',
      descendant:
        '.pagedjs_page { --desc-position:fixed } .fixed { position:var(--desc-position,static) }',
    },
    // Keep token boxes tiny while their text overflows: this isolates the text
    // guard from the independent element-clipping check. An axis set to visible
    // computes to auto when the other axis is hidden; it still is not sealed.
  ].map(({ name, css, ancestor = '', descendant = '' }) => ({
    name,
    text: 'UNSEALED',
    css: `.clip { display:block;position:absolute;width:1px;height:1px;overflow:hidden;overflow-clip-margin:0px;padding:0;border:0;${css} } ${ancestor} .fixed { display:contents } math, mtext { display:block;width:1px;height:1px } ${descendant}`,
  })),
];

test.each(paintRegressions)(
  'requires missing text when $name',
  async ({ css, text }) => {
    const response = await print(
      document(
        `<p data-gt="paragraph"><span class="ancestor"><span class="clip katex-mathml"><span class="fixed"><math><mtext>${text}</mtext></math></span></span></span></p>`,
        `<style>${css} mtext { visibility:hidden }</style>`,
      ),
    );
    expect(
      response.status,
      response.status === 200
        ? 'unexpected PDF success: painted-copy text was exempted'
        : await response.clone().text(),
    ).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('text_missing');
    expect(error.details?.map(detail => detail.message)).toContain(
      `page 1: ${text}`,
    );
  },
);

const strictCopyCases = [
  {
    name: 'fieldset legend escapes the wrapper clip',
    markup:
      '<fieldset class="clip katex-mathml"><legend><math><mtext>REQUIRED</mtext></math></legend></fieldset>',
  },
  {
    name: 'MathML itself is not a span or div wrapper',
    markup: '<math class="clip katex-mathml"><mtext>REQUIRED</mtext></math>',
  },
  {
    name: 'flex wrapper is not a sealed block',
    markup:
      '<span class="clip katex-mathml" style="display:flex"><math><mtext>REQUIRED</mtext></math></span>',
  },
  {
    name: 'height alone exceeds one pixel',
    markup:
      '<span class="clip katex-mathml" style="height:2px"><math><mtext>REQUIRED</mtext></math></span>',
  },
  {
    name: 'sealed HTML text without MathML',
    markup:
      '<span class="clip katex-mathml"><span class="required">REQUIRED</span></span>',
  },
  {
    name: 'sealed HTML text alongside MathML',
    markup:
      '<span class="clip katex-mathml"><span class="required">REQUIRED</span><math><mtext>COPY</mtext></math></span>',
  },
  {
    name: 'data-gt marked mtext inside a sealed wrapper',
    markup:
      '<span class="clip katex-mathml"><math><mtext data-gt="paragraph">REQUIRED</mtext></math></span>',
  },
];

test.each(strictCopyCases)(
  'round 5 requires missing text from $name',
  async ({ markup }) => {
    const response = await print(
      document(
        `<div data-gt="paragraph">PRINTED${markup}</div>`,
        `<style>${sealingCss} .clip { overflow-clip-margin:0px;min-inline-size:0 } math, mtext, legend, .required { display:block;width:1px;height:1px;padding:0;border:0 } mtext, .required { visibility:hidden }</style>`,
      ),
    );
    expect(
      response.status,
      response.status === 200
        ? 'unexpected PDF success'
        : await response.clone().text(),
    ).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('text_missing');
    expect(error.details?.map(detail => detail.message)).toContain(
      'page 1: REQUIRED',
    );
  },
);

const sealedPaintRegressions = [
  { name: 'CSS height', css: 'mtext { height:1px }' },
  { name: 'block display', css: 'mtext { display:block }' },
  { name: 'negative letter spacing', css: 'mtext { letter-spacing:-100px }' },
  { name: 'text stroke', css: 'mtext { -webkit-text-stroke:4px black }' },
  { name: 'text emphasis', css: 'mtext { text-emphasis:filled dot }' },
  {
    name: 'token drop shadow',
    css: 'mtext { filter:drop-shadow(10px 0 black) }',
  },
  { name: 'token reflection', css: 'mtext { -webkit-box-reflect:below }' },
  {
    name: 'ancestor drop shadow',
    css: '.clip { filter:drop-shadow(10px 0 black) }',
  },
];
const sealingCss =
  '.clip { display:block;position:absolute;clip:rect(1px,1px,1px,1px);padding:0;border:0;height:1px;width:1px;overflow:hidden }';

test.each(sealedPaintRegressions)(
  'exempts a sealed copy despite $name on its content',
  async ({ css }) => {
    const response = await print(
      document(
        '<p data-gt="paragraph">PRINTED<span class="clip katex-mathml"><math><mtext>SEALED</mtext></math></span></p>',
        `<style>${sealingCss} ${css} mtext { visibility:hidden }</style>`,
      ),
    );
    expect(
      response.status,
      response.status === 200 ? '' : await response.clone().text(),
    ).toBe(200);
    await response.arrayBuffer();
  },
);

// Narrowing the exemption must retain KaTeX's real clipped MathML copy,
// including its LaTeX annotation, for both formula layouts.
test.each([
  { name: 'inline', displayMode: false },
  { name: 'display', displayMode: true },
])(
  'prints real $name KaTeX with its hidden MathML copy',
  async ({ displayMode }) => {
    const formula = katex.renderToString('\\frac{a}{b} + \\sqrt{2}', {
      displayMode,
    });
    const body = displayMode
      ? `<p data-gt="paragraph">公式如下：</p><div data-gt="formula">${formula}</div>`
      : `<p data-gt="paragraph">比值${formula}結束。</p>`;
    const response = await print(
      document(body, '<link rel="stylesheet" href="katex.min.css">'),
      katexFiles,
    );
    expect(
      response.status,
      response.status === 200 ? '' : await response.clone().text(),
    ).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
    await response.arrayBuffer();
  },
);
