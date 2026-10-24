import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { apiErrorSchema } from '@pdf-generator/contract';
import katex from 'katex';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'text-layout-compatibility-local-test-token';
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

function document(body: string, css = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="../styles/katex.min.css">
<style>@page { margin: 20mm; }
body { margin: 0; font: 16px/24px "Noto Sans TC"; }
${css}</style></head><body>${body}</body></html>`;
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

async function printed(response: Response) {
  const error = response.status === 200 ? '' : await response.clone().text();
  expect(response.status, error).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  return new Uint8Array(await response.arrayBuffer());
}

// Restricting candidates to the element border box wrongly discards both
// lower lines and a nowrap PDF item's anchor beyond the right edge.
test('visible vertical and nowrap overflow still prints outside a fixed data-gt box', async () => {
  await printed(
    await print(
      document(`
<div data-gt="paragraph" style="height: 12px; width: 220px; overflow: visible">
Vertical overflow begins here.<br>Lower overflow remains printed.</div>
<div data-gt="paragraph" style="margin-top: 100px; width: 16px; white-space: nowrap; overflow: visible">Horizontal overflow remains printed beyond the narrow border.</div>`),
    ),
  );
});

// A descendant's painted text, rather than its ancestor's normal-flow box,
// must supply the candidate region for the text-layer guard.
test('a relatively positioned descendant still prints below its data-gt parent', async () => {
  await printed(
    await print(
      document(`<p data-gt="paragraph" style="height: 24px">
<span style="position: relative; top: 60px">Displaced descendant remains printed.</span></p>`),
    ),
  );
});

// Paged.js clones one paragraph into page fragments. Reusing the original
// paragraph's complete text or first-page coordinates rejects its continuation.
test('one English paragraph split by Paged.js checks only the text on each of two pages', async () => {
  const prose = `Opening marker. ${'Every careful reader can follow this English paragraph as it continues naturally onto the following printed page. '.repeat(40)}Closing marker.`;
  const response = await print(document(`<p data-gt="paragraph">${prose}</p>`));
  const bytes = await printed(response);
  const pdf = await getDocumentProxy(bytes);
  try {
    expect(pdf.numPages).toBe(2);
    expect(response.headers.get('x-page-count')).toBe('2');
    const { text } = await extractText(pdf, { mergePages: false });
    expect(text[0]).toContain('Opening marker.');
    expect(text[0]).not.toContain('Closing marker.');
    expect(text[1]).toContain('Closing marker.');
    expect(text[1]).not.toContain('Opening marker.');
    expect(text.join('').replace(/\s/g, '')).toBe(prose.replace(/\s/g, ''));
  } finally {
    await pdf.loadingTask.destroy();
  }
});

function nestedFormula(css = '') {
  return document(
    `<p data-gt="paragraph">Let <span data-gt="formula">${katex.renderToString('x')}</span> be the next example of a real number.</p>`,
    css,
  );
}

// The ancestor includes the formula geometrically, but its own prose must
// not consume the nested block's x (or require the nested x a second time).
test('an inline formula with its own data-gt block prints inside English prose containing its letter', async () => {
  await printed(await print(nestedFormula()));
});

// Widening the nested formula's candidate region to its parent or the page
// would let the x in "next example" conceal a missing formula glyph.
test('a hidden nested inline formula is text_missing even when its letter occurs in the parent prose', async () => {
  const response = await print(
    nestedFormula('.katex-html { visibility: hidden; }'),
  );
  const body = await response.text();
  expect(response.status, body).toBe(422);
  const { error } = apiErrorSchema.parse(JSON.parse(body));
  expect(error.code).toBe('text_missing');
  expect(
    (error.details ?? []).map(detail => detail.message),
    body,
  ).toEqual(['page 1: x']);
});
