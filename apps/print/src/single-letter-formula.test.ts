import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { apiErrorSchema } from '@pdf-generator/contract';
import katex from 'katex';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'single-letter-formula-local-test-token';
const katexFiles: Record<string, string> = {};
let worker: PrintWorker;

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
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function formulaDocument(css = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="../styles/katex.min.css">
<style>@page { margin: 20mm; } body { margin: 0; font: 16px "Noto Sans TC"; }
${css}</style></head><body>
<p data-gt="paragraph">We study the next example: every circle has a radius.</p>
<div data-gt="formula">${katex.renderToString('x^2 + y^2 = r^2', { displayMode: true })}</div>
<p data-gt="paragraph">Let ${katex.renderToString('x')} be any real number and ${katex.renderToString('r')} the radius.</p>
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

// A page-wide check consumes x, y and r from prose in earlier positions and
// falsely rejects the prose even when every visible glyph reached the PDF.
test('single-letter display and inline formulas do not consume letters from English prose', async () => {
  const response = await print(formulaDocument());
  const body = response.status === 200 ? '' : await response.clone().text();
  expect(response.status, body).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
});

// Matching a missing formula against identical letters elsewhere on the page
// must not hide its absence or report the surrounding English as missing.
test('unprinted single-letter formulas are reported as formula text despite matching letters in English prose', async () => {
  const response = await print(
    formulaDocument('.katex-html { visibility: hidden; }'),
  );
  const body = await response.text();
  expect(response.status, body).toBe(422);
  const { error } = apiErrorSchema.parse(JSON.parse(body));
  expect(error.code).toBe('text_missing');
  const messages = (error.details ?? []).map(detail => detail.message);
  expect(messages, body).toContain('page 1: x');
  expect(messages, body).toContain('page 1: r');
  // Every reported fragment belongs to visible formula glyphs: no English
  // prose, MathML annotation, or LaTeX source such as x^2 is allowed.
  expect(
    messages.every(message => /^page 1: [xyr2+=]+$/u.test(message)),
    body,
  ).toBe(true);
});
