import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'platform-shared-glyph-local-test-token';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

const cases = [
  ...['Noto Sans TC', 'Noto Serif TC'].flatMap(family =>
    [400, 700].map(weight => ({ family, weight, source: '／∕・·•‧…⋯–‒' })),
  ),
  {
    family: 'LXGW WenKai TC',
    weight: 400,
    source: '清淸青靑真眞教敎值値溫温刪删宮宫鄉郷尚尙告吿侶侣〈～∙·∼~',
  },
];

test.each(cases)(
  'platform $family weight $weight preserves shared code points in one-line and wrapped data-gt blocks without pack fonts',
  async ({ family, weight, source }) => {
    // Include both surviving members of each shared glyph: a higher code point
    // alone can pass when Chrome subsets away its lower-code-point partner.
    const html = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<style>@page { margin: 20mm; }
body { margin: 0; font: ${weight} 24px/32px "${family}"; }
p { white-space: nowrap; }
p.wrapped { white-space: normal; word-break: break-all; width: 48px; }
</style></head><body><p data-gt="paragraph">${source}</p>
<p class="wrapped" data-gt="paragraph">${source}</p></body></html>`;
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
    const pdf = await getDocumentProxy(
      new Uint8Array(await response.arrayBuffer()),
    );
    try {
      const { text } = await extractText(pdf, { mergePages: true });
      // Ignore line/item joining whitespace only; preserve every source code point.
      expect(text.replace(/\s/gu, '')).toBe(source.repeat(2));
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const lines = new Set(
        content.items.flatMap(item =>
          'str' in item && item.str.trim() ? [item.transform[5]] : [],
        ),
      );
      expect(lines.size, 'the second block actually wraps').toBeGreaterThan(2);
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);
