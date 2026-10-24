import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'locl-text-layer-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const cases = (['en', 'zh-TW'] as const).flatMap(lang =>
  ['Noto Sans TC', 'Noto Serif TC'].map(family => ({ lang, family })),
);

test.each(cases)(
  '$lang / $family preserves dates, amounts and punctuation in regular and bold PDF text instead of text_missing or U+0000',
  async ({ lang, family }) => {
    const source = [
      '2026-10-24 NT$1,234,567.89',
      lang === 'en' ? 'Quarterly report…' : `營收—成本 "Q3" it's`,
    ].join(' ');
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<style>@page { margin: 20mm; } body { margin: 0; font: 16px/24px "${family}"; }
p { white-space: nowrap; }</style></head><body>
<p data-gt="paragraph">${source}</p>
<p data-gt="paragraph" style="font-weight: 700">${source}</p>
</body></html>`;
    const response = await fetch(new URL('/print', (await worker.url).href), {
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
    const error = response.status === 200 ? '' : await response.clone().text();
    expect(response.status, error).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
    const pdf = await getDocumentProxy(
      new Uint8Array(await response.arrayBuffer()),
    );
    try {
      const { text } = await extractText(pdf, { mergePages: true });
      expect(text).not.toContain('\u0000');
      // Whitespace alone may change when PDF items are joined. Keep every
      // code point, including quotes, ellipsis and U+2014, otherwise exact.
      expect(text.replace(/\s/gu, '')).toBe(
        `${source}${source}`.replace(/\s/gu, ''),
      );
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);
