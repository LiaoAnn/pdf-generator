import { URL } from 'node:url';
import { gtSchema } from '@pdf-generator/contract';
import { checkPdf, readPdf } from '@pdf-generator/self-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'page-numbers-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const slots =
  '第 <span data-gt-page-number></span> 頁，共 <span data-gt-page-count></span> 頁';
const compact = (text: string) => text.replace(/\s/g, '');

async function printThreePages(runningFooter: boolean, slotOnlyFont = false) {
  const pageSlots = slotOnlyFont
    ? slots.replaceAll('<span ', '<span class="page-digit" ')
    : slots;
  const response = await fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
        <style>
          @page { margin: 20mm;
            ${runningFooter ? '@bottom-right { content: element(pageNumber); }' : ''}
          }
          body { margin: 0; font: 16px "Noto Sans TC"; }
          ${slotOnlyFont ? '.page-digit { font-family: "Noto Serif TC"; font-weight: 700; }' : ''}
          .pn { position: running(pageNumber); white-space: nowrap; }
          section { height: 100mm; }
          section + section { break-before: page; }
          p { margin: 0; }
        </style></head><body>
        ${runningFooter ? `<div class="pn" data-gt="page_number">${pageSlots}</div>` : ''}
        <section><p data-gt="paragraph">Alpha</p></section>
        <section><p data-gt="paragraph">Beta</p>
          ${runningFooter ? '' : `<p data-gt="page_number">${pageSlots}</p>`}
        </section>
        <section><p data-gt="paragraph">Gamma</p></section>
        </body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'page-numbers',
        templateVersion: 1,
        seed: 'page-numbers-slice-two',
        index: 0,
      },
    }),
  });
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const body = (await response.json()) as {
    pageCount: number;
    pdf: string;
    gt: unknown;
  };
  const gt = gtSchema.parse(body.gt);
  const pdf = new Uint8Array(Buffer.from(body.pdf, 'base64'));
  const { pages } = await readPdf(pdf);
  expect(body.pageCount).toBe(3);
  expect(gt.pages).toHaveLength(3);
  expect(pages).toHaveLength(3);
  return { gt, pdf, pages };
}

test('POST /print fills each running footer clone with its own page number and final total in GT and PDF', async () => {
  // Catches filling only the source running element, filling before pagination,
  // or mutating slots after GT/PDF text expectations have already been read.
  const { gt, pdf, pages } = await printThreePages(true);
  expect(
    gt.blocks
      .filter(block => block.type === 'page_number')
      .map(block => ({ page: block.page, text: compact(block.text) })),
  ).toEqual([
    { page: 1, text: '第1頁，共3頁' },
    { page: 2, text: '第2頁，共3頁' },
    { page: 3, text: '第3頁，共3頁' },
  ]);
  for (const [index, page] of pages.entries()) {
    // Check the margin itself: body digits must not mask a missing footer.
    const footer = page.items.filter(item => item.baseline > page.height - 57);
    expect(compact(footer.map(item => item.text).join(''))).toBe(
      `第${index + 1}頁，共3頁`,
    );
  }
  expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
});

test('POST /print fills body slots with their containing page number rather than the first page or total', async () => {
  // Page 2 of 3 distinguishes the containing page from both 1 and the total;
  // catches implementations that visit only Paged.js margin clones.
  const { gt, pdf, pages } = await printThreePages(false);
  expect(
    gt.blocks
      .filter(block => block.type === 'page_number')
      .map(block => ({ page: block.page, text: compact(block.text) })),
  ).toEqual([{ page: 2, text: '第2頁，共3頁' }]);
  expect(
    pages.map(page => compact(page.items.map(item => item.text).join(''))),
  ).toEqual(['Alpha', 'Beta第2頁，共3頁', 'Gamma']);
  expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
});

test.each([
  { placement: 'running footer', runningFooter: true },
  { placement: 'in-flow paragraph', runningFooter: false },
])(
  'POST /print embeds and uses bold serif set only on empty $placement page-number slots',
  async ({ runningFooter }) => {
    // Empty slots have no text when font selection runs. Styling only the spans
    // in an ordinary rule prevents body text or @page font discovery from
    // masking a skipped slot; checking the digits also catches fallback printing
    // even if the requested face was embedded elsewhere.
    const { gt, pdf, pages } = await printThreePages(runningFooter, true);
    expect(
      gt.blocks
        .filter(block => block.type === 'page_number')
        .map(block => ({ page: block.page, text: compact(block.text) })),
    ).toEqual(
      runningFooter
        ? [
            { page: 1, text: '第1頁，共3頁' },
            { page: 2, text: '第2頁，共3頁' },
            { page: 3, text: '第3頁，共3頁' },
          ]
        : [{ page: 2, text: '第2頁，共3頁' }],
    );
    expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });

    const raw = Buffer.from(pdf).toString('latin1');
    const embedded = [...raw.matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g)].map(
      match => (match[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
    );
    expect.soft(embedded).toContain('NotoSerifTC-Bold');
    expect(raw).toMatch(/\/FontFile[23]?\b/);
    for (const [index, page] of pages.entries()) {
      const digits = page.items.filter(item => /[0-9]/.test(item.text));
      expect(digits.map(item => compact(item.text)).join('')).toBe(
        runningFooter ? `${index + 1}3` : index === 1 ? '23' : '',
      );
      for (const digit of digits) {
        expect
          .soft(digit.font, `page ${index + 1}: ${digit.text}`)
          .toBe('NotoSerifTC-Bold');
      }
    }
  },
);
