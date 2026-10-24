import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { patchCmap } from './fonts/sfnt.ts';
import { withSharedCmap } from './test-fixtures/shared-cmap.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'shared-glyph-local-test-token';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

test.each([
  'LXGWWenKaiTC-Regular.ttf',
  'NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf',
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
])(
  '%s preserves shared-glyph code points in one-line and wrapped data-gt PDF text',
  async name => {
    const trueType = name.endsWith('.ttf');
    const original = withSharedCmap(
      await readFile(new URL(`../public/fonts/${name}`, import.meta.url)),
      trueType,
    );
    const { font } = patchCmap(original);
    // Include both surviving members: testing only the higher code point can
    // miss a ToUnicode collision when Chrome subsets the font.
    const source = trueType
      ? '清淸青靑真眞教敎值値溫温刪删宮宫鄉郷尚尙告吿侶侣〈～∙·∼~'
      : '／∕・·•‧…⋯–‒';
    const file = trueType ? 'fixture.ttf' : 'fixture.otf';
    const format = trueType ? 'truetype' : 'opentype';
    const weight = name.includes('Bold') ? 700 : 400;
    // Only one face per request: a pair of full CJK fonts exceeds pack limits.
    // Wrapping at every character exercises extraction across PDF text items.
    const html = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<style>
@font-face { font-family: "Unique Cmap"; src: url("./${file}") format("${format}"); font-weight: ${weight}; }
@page { margin: 20mm; }
body { margin: 0; font: ${weight} 24px/32px "Unique Cmap"; }
p { white-space: nowrap; } p.wrapped { white-space: normal; word-break: break-all; width: 48px; }
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
        pack: {
          template: 'index.html',
          files: { [file]: Buffer.from(font).toString('base64') },
        },
      }),
    });
    const error = response.status === 200 ? '' : await response.clone().text();
    expect(response.status, error).toBe(200);
    const pdf = await getDocumentProxy(
      new Uint8Array(await response.arrayBuffer()),
    );
    try {
      const { text } = await extractText(pdf, { mergePages: true });
      expect(text.replace(/\s/gu, '')).toBe(source.repeat(2));
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const lines = new Set(
        content.items.flatMap(item =>
          'str' in item && item.str.trim() ? [item.transform[5]] : [],
        ),
      );
      expect(
        lines.size,
        'the second data-gt block actually wraps',
      ).toBeGreaterThan(2);
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);
