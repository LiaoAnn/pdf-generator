import { URL } from 'node:url';
import { apiErrorSchema } from '@pdf-generator/contract';
import { readPdf } from '@pdf-generator/self-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'text-cells-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

async function print(body: string, css = '') {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { margin: 20mm; } body { margin: 0; font: 16px "Noto Sans TC"; }
        table { border-collapse: collapse; } td { width: 80px; padding: 8px; }
        ${css}</style></head><body>${body}</body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
    }),
  });
}

test('adjacent numeric cells cannot steal characters across cell boundaries and reject an intact table', async () => {
  // Unlike 3.19|3.01|93.01, this sequence loses 3.19 with the old
  // longest-first concatenation matcher, even after removals rejoin the pool.
  const values = ['3.19', '3.01', '3.01', '93.01'];
  const response = await print(
    `<table data-gt="table"><tr>${values.map(value => `<td>${value}</td>`).join('')}</tr></table>`,
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const { pages } = await readPdf(new Uint8Array(await response.arrayBuffer()));
  expect(pages[0]?.items.map(item => item.text)).toEqual(values);
});

test('a hidden numeric cell is still reported even when adjacent printed cells concatenate to its number', async () => {
  const response = await print(
    '<table data-gt="table"><tr><td>3.19</td><td>3.01</td><td style="visibility:hidden">93.01</td></tr></table>',
  );
  expect(response.status).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('text_missing');
  expect(error.details).toContainEqual({ message: 'page 1: 93.01' });
});

test('a heading split into widely spaced glyph items still supplies its whole text node', async () => {
  const response = await print(
    '<h1 data-gt="title">REPORT</h1>',
    'h1 { font-size: 20px; letter-spacing: 1em; }',
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const { pages } = await readPdf(new Uint8Array(await response.arrayBuffer()));
  expect(pages[0]?.items.map(item => item.text)).toEqual([...'REPORT']);
});

test('a wrapped paragraph can match one text node across all of its line fragments', async () => {
  const text =
    'Monthly revenue increased while operating costs remained stable.';
  const response = await print(
    `<p data-gt="paragraph">${text}</p>`,
    'p { width: 150px; }',
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const { pages } = await readPdf(new Uint8Array(await response.arrayBuffer()));
  const items = pages[0]?.items ?? [];
  expect(
    new Set(items.map(item => Math.round(item.baseline))).size,
  ).toBeGreaterThan(1);
  expect(
    items
      .map(item => item.text)
      .join('')
      .replace(/\s/g, ''),
  ).toBe(text.replace(/\s/g, ''));
});
