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
