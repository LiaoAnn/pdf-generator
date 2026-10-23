import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';

const token = 'slice-three-table-safety-test-token';
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
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
    }),
  });
}

async function fixture(name: string) {
  return readFile(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8');
}

const compact = (text: string) => text.replace(/\s/gu, '');

test('T03 lost-row document prints all 45 complete rows and repeats the header above page 3 rows', async () => {
  const html = await readFile(
    new URL('../acceptance/table.html', import.meta.url),
    'utf8',
  );
  const response = await print(html);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/i);
  const pdf = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    expect(pdf.numPages).toBe(4);
    expect(response.headers.get('x-page-count')).toBe('4');
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map(compact);
    // Independent source expectation: every cell of every source row must be
    // printed together, once, rather than checking only the row number.
    const table = /<tbody>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? '';
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map(match =>
      compact(match[1]?.replace(/<[^>]*>/g, '') ?? ''),
    );
    expect(rows).toHaveLength(45);
    for (const row of rows) {
      expect
        .soft(
          pages.filter(page => page.includes(row)),
          `complete row ${row}`,
        )
        .toHaveLength(1);
      expect
        .soft(pages.join('').split(row).length - 1, `row printed once: ${row}`)
        .toBe(1);
    }
    const header = '編號門市營收（元）狀態';
    expect.soft(pages[1]).toContain(header);
    expect.soft(pages[2]).toContain(header);
    const third = await pdf.getPage(3);
    const { items } = await third.getTextContent();
    const texts = items.filter(item => 'str' in item);
    const headerItem = texts.find(item => item.str === '編號');
    const firstRow = texts.find(item => /^0\d{2}$/.test(item.str));
    expect.soft(headerItem, 'page 3 must print its table header').toBeDefined();
    expect(firstRow).toBeDefined();
    if (headerItem && firstRow) {
      expect(headerItem.transform[5]).toBeGreaterThan(firstRow.transform[5]);
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('every continuation repeats the full two-row header before body cells and headless tables retain every row once', async () => {
  const response = await print(await fixture('long-tables.html'));
  expect(response.status).toBe(200);
  const pdf = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const headedPages = text.flatMap((page, i) =>
      /ROW_[A-Z]{2}/.test(page) ? [i] : [],
    );
    const plainPages = text.flatMap((page, i) =>
      /PLAIN_[A-Z]{2}/.test(page) ? [i] : [],
    );
    expect(headedPages.length).toBeGreaterThanOrEqual(3);
    expect(plainPages.length).toBeGreaterThanOrEqual(2);
    for (const [prefix, value, count] of [
      ['ROW', 'VALUE', 32],
      ['PLAIN', 'CELL', 12],
    ] as const) {
      for (let n = 1; n <= count; n++) {
        const id = String.fromCharCode(
          65 + Math.floor((n - 1) / 26),
          65 + ((n - 1) % 26),
        );
        const row = `${prefix}_${id}`;
        const cell = `${value}_${id}`;
        expect
          .soft(
            text.join(' ').match(new RegExp(`\\b${row}\\b`, 'g')) ?? [],
            row,
          )
          .toHaveLength(1);
        expect
          .soft(
            text.join(' ').match(new RegExp(`\\b${cell}\\b`, 'g')) ?? [],
            cell,
          )
          .toHaveLength(1);
        expect
          .soft(
            text.filter(page => page.includes(row) && page.includes(cell)),
            `${row} cells on one page`,
          )
          .toHaveLength(1);
      }
    }
    for (const i of headedPages) {
      const { items } = await (await pdf.getPage(i + 1)).getTextContent();
      const printed = items
        .filter(item => 'str' in item)
        .filter(item => item.str.trim());
      const firstRow = printed.find(item => /^ROW_[A-Z]{2}$/.test(item.str));
      expect(firstRow).toBeDefined();
      for (const label of ['HEAD_ID', 'HEAD_VALUE', 'HEAD_UNITS']) {
        const headers = printed.filter(item => item.str === label);
        expect.soft(headers, `${label} on page ${i + 1}`).toHaveLength(1);
        if (headers[0] && firstRow) {
          expect
            .soft(
              headers[0].transform[5],
              `${label} above body on page ${i + 1}`,
            )
            .toBeGreaterThan(firstRow.transform[5]);
        }
      }
    }
    for (const i of plainPages) {
      expect.soft(text[i]).not.toContain('HEAD_');
      // A headless fragment must not manufacture a header from its first row.
      expect
        .soft(text[i]?.match(/PLAIN_AA/g) ?? [])
        .toHaveLength(i === plainPages[0] ? 1 : 0);
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('broken used and unused document-declared faces return font_not_loaded and name both families', async () => {
  const response = await print(await fixture('broken-font.html'));
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('font_not_loaded');
  for (const family of ['Broken Fixture TC', 'Unused Broken TC']) {
    expect(
      error.details?.some(detail => detail.message.includes(family)),
      family,
    ).toBe(true);
  }
});

test('an oversized text row returns row_fragmented with row text instead of a clipped PDF', async () => {
  const response = await print(await fixture('oversized-row.html'));
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('row_fragmented');
  expect(
    error.details?.some(detail =>
      detail.message.includes('TOP_OF_OVERSIZED_ROW'),
    ),
  ).toBe(true);
});

test('a row wider than page content returns row_fragmented even without a vertical split', async () => {
  const response = await print(await fixture('wide-row.html'));
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('row_fragmented');
  expect(
    error.details?.some(detail => detail.message.includes('WIDE_ROW')),
  ).toBe(true);
});
