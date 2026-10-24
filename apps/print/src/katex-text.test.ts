import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiErrorSchema } from '@pdf-generator/contract';
import katex from 'katex';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';

const token = 'katex-text-local-test-token';
type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;
let worker: Worker;
// KaTeX's stylesheet and every woff2 it declares, as pack files: the print
// browser loads only pack files and platform fonts.
const katexFiles: Record<string, string> = {};

beforeAll(async () => {
  const dist = dirname(
    createRequire(import.meta.url).resolve('katex/dist/katex.min.css'),
  );
  katexFiles['styles/katex.min.css'] = (
    await readFile(join(dist, 'katex.min.css'))
  ).toString('base64');
  for (const name of await readdir(join(dist, 'fonts'))) {
    if (!name.endsWith('.woff2')) continue;
    katexFiles[`styles/fonts/${name}`] = (
      await readFile(join(dist, 'fonts', name))
    ).toString('base64');
  }
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    bindings: { PRINT_TOKEN: { type: 'plain_text', value: token } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false },
  });
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const inline = (tex: string) => katex.renderToString(tex);
const display = (tex: string) =>
  katex.renderToString(tex, { displayMode: true });

// The prose is CJK on purpose: the text check consumes one occurrence of each
// expected text from the page text, so single Latin letters of a formula (x, r, a)
// would otherwise consume the same letters out of Latin prose before it.
// Pre-rendered KaTeX markup, as a template pack contains it: the visible
// `.katex-html` plus the hidden `.katex-mathml` copy with its LaTeX
// `<annotation>`. `css` is appended to the document's own style.
function formulaDocument(css = '') {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<link rel="stylesheet" href="../styles/katex.min.css">
<style>@page { margin: 20mm; } body { margin: 0; font: 16px "Noto Sans TC"; }
${css}</style></head><body>
<p data-gt="paragraph">圓的方程式如下：</p>
<div data-gt="formula">${display('x^2 + y^2 = r^2')}</div>
<p data-gt="formula">比值${inline('\\frac{a}{b}')}與平方根${inline('\\sqrt{2}')}。</p>
</body></html>`;
}

async function print(html: string) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      pack: { template: 'templates/report.hbs', files: katexFiles },
    }),
  });
}

// Regression: the runtime expects KaTeX's hidden MathML copy (and its LaTeX
// annotation) to be in the PDF, so every real formula fails with text_missing
// even though everything visible was printed (PR #13).
test('a document with inline and display KaTeX formulas prints with the formula and its surrounding text in the PDF', async () => {
  const response = await print(formulaDocument());
  const body = response.status === 200 ? '' : await response.clone().text();
  expect(response.status, body).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  const document = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    const { text } = await extractText(document, { mergePages: true });
    const normalized = text.normalize('NFKC').replace(/\s/gu, '');
    expect(normalized).toContain('圓的方程式如下');
    expect(normalized).toContain('與平方根');
    // The visible glyphs are in the text layer; the LaTeX source is not.
    // (Their order in the extracted text is pdf.js's, so it is not pinned.)
    expect(normalized).toContain('+');
    expect(normalized).toContain('=');
    expect(normalized).not.toContain('x^2');
    expect(normalized).not.toContain('\\frac');
  } finally {
    await document.loadingTask.destroy();
  }
});

// Regression: skipping KaTeX text wholesale (or excluding all of .katex) would
// let a formula whose visible glyphs were not printed through the check. The
// visible part keeps its layout (so the runtime still sees it as visible) but
// is not drawn, which is "visible formula text missing from the PDF"; the
// MathML copy staying in the page must not make up for it.
test('visible KaTeX text that stays in layout but is not printed is caught as text_missing', async () => {
  const response = await print(
    formulaDocument('.katex-html { visibility: hidden; }'),
  );
  expect(response.status).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('text_missing');
  const messages = (error.details ?? []).map(detail => detail.message);
  expect(messages.length, JSON.stringify(messages)).toBeGreaterThan(0);
  // The plain text around the formulas was printed, so only formula text is named.
  expect(messages.join('|')).not.toMatch(/[圓比值與平方根]/u);
  expect(messages.every(message => message.startsWith('page 1: '))).toBe(true);
  // Text that exists only in the formulas (not in the surrounding prose).
  expect(messages).toContain('page 1: +');
  expect(messages).toContain('page 1: =');
  // Never the LaTeX source in the MathML annotation.
  expect(messages.join('|')).not.toContain('\\frac');
});
