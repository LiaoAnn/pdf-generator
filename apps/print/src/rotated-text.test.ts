// T07-19: the print's text check (missingText) read every PDF text item as
// horizontal, so data-gt text rotated +90° or 180° (a stamp's 內部使用, an
// upside-down 倒置文字) was refused as text_missing although it printed in
// its box; -90° passed only because its glyphs happened to overlap its
// baseline's x range. Rotated text now prints, and rotated text that the PDF
// lacks is still refused.
import { apiErrorSchema } from '@pdf-generator/contract';
import { readPdf } from '@pdf-generator/self-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'rotated-text-local-test';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function document(body: string) {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<style>
@page { size: A4; margin: 20mm; }
body { margin: 0; font: 16px/24px "Noto Sans TC"; }
.stamp { display: inline-block; margin: 60px; }
</style></head><body><p data-gt="paragraph">前文照常印出。</p>${body}</body></html>`;
}

async function print(html: string) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
    }),
  });
}

test.each([
  { angle: 90, text: '內部使用', style: '' },
  { angle: 180, text: '倒置文字', style: '' },
  { angle: -90, text: '機密文件', style: '' },
  // Wrapped: one PDF item and one client rect per rotated line.
  { angle: 90, text: '內部使用僅限本公司', style: 'width:4em;' },
])(
  'prints data-gt text rotated $angle° ($text)',
  async ({ angle, text, style }) => {
    const response = await print(
      document(
        `<div data-gt="paragraph" class="stamp" style="${style}transform:rotate(${angle}deg)">${text}</div>`,
      ),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const pdf = new Uint8Array(await response.arrayBuffer());
    // The text really printed rotated: readPdf reports a direction for it.
    const { pages } = await readPdf(pdf);
    const items = pages[0]?.items ?? [];
    const rotated = items.filter(item => item.dir);
    expect(rotated.map(item => item.text).join('')).toBe(text);
    expect(items.map(item => item.text).join('')).toContain('前文照常印出');
  },
);

// The control: rotated text that is laid out but not printed is still
// missing from its box.
test.each([{ angle: 90 }, { angle: 180 }, { angle: -90 }])(
  'refuses unprinted data-gt text rotated $angle° as text_missing',
  async ({ angle }) => {
    const response = await print(
      document(
        `<div data-gt="paragraph" class="stamp" style="transform:rotate(${angle}deg)">印出<span style="visibility:hidden">藏起</span></div>`,
      ),
    );
    expect(
      response.status,
      response.status === 200
        ? 'unexpected PDF success: unprinted rotated text was not missed'
        : await response.clone().text(),
    ).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('text_missing');
    expect(error.details?.map(item => item.message)).toEqual(['page 1: 藏起']);
  },
);
