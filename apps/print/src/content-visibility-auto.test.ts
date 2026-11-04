// T08-9: Chrome skips the contents of a content-visibility: auto element
// away from the viewport: innerText leaves out their text and layout gives
// them their skipped size (zero, or contain-intrinsic-size), which moves
// every box after them too. Printing lays all of it out and prints it. Probed
// through the real web → print pipeline on local Chromium
// (~/drafts/t08-9-content-visibility-auto/probe/): auto content near the
// bottom of page 1 was refused as viewport_dependent (skipped at the 800x600
// viewport Paged.js paginates at, laid out at the page size), auto content
// on pages 2 and 3 as text_missing (with a font-shaped explanation), though
// the PDF printed all of it. Print now checks and reads that content as it
// prints. What Paged.js paginated while it was skipped and only grows in
// print still reaches past its page, and the PDF loses it: that stays
// print_overflow.
import { URL } from 'node:url';
import { apiErrorSchema, gtSchema } from '@pdf-generator/contract';
import { checkPdf } from '@pdf-generator/self-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'content-visibility-auto-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

// The structures the probe found printed differently from what was read, on
// page `n`: text in an inline-block auto box inside a block, a block inside
// an auto ancestor, an auto block itself, an auto ancestor whose
// contain-intrinsic-size differs from its content, a block holding an auto
// descendant, an auto ancestor under user-select: none, nested auto
// ancestors, and a plain block after them (moved by their sizes).
const structures = (n: number) => `
  <p data-gt="paragraph">可見文字戊<span class="cv ib">隱藏文字己${n}</span></p>
  <div class="cv"><p data-gt="paragraph">祖先段落丙${n}</p></div>
  <p data-gt="paragraph" class="cv">自身段落丁${n}</p>
  <div class="cv cis"><p data-gt="paragraph">尺寸段落戊${n}<br>第二行${n}</p></div>
  <div data-gt="paragraph">外層文字${n}<div class="cv">內層文字${n}</div></div>
  <div class="unselectable"><div class="cv"><p data-gt="paragraph">選取無效${n}</p></div></div>
  <div class="cv"><div class="cv"><p data-gt="paragraph">巢狀段落${n}</p></div></div>
  <p data-gt="paragraph">後續標記${n}</p>`;
const expectedTexts = (n: number) => [
  `可見文字戊隱藏文字己${n}`,
  `祖先段落丙${n}`,
  `自身段落丁${n}`,
  `尺寸段落戊${n}\n第二行${n}`,
  `外層文字${n}\n內層文字${n}`,
  `選取無效${n}`,
  `巢狀段落${n}`,
  `後續標記${n}`,
];

function document(body: string, visibility: string) {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px "Noto Sans TC"; }
    p, section > div { margin: 0 0 8px; }
    .cv { content-visibility: ${visibility}; }
    .ib { display: inline-block; }
    .cis { contain-intrinsic-size: auto 60px; }
    .unselectable { user-select: none; }
    .spacer { height: 228mm; }
    .next { break-before: page; }
    </style></head><body><p data-gt="title">標題</p>${body}</body></html>`;
}

async function post(html: string) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'content-visibility-auto',
        templateVersion: 1,
        seed: 'T08-9',
        index: 0,
      },
    }),
  });
}

// Printed, with gt.json holding every expected text on its page and the
// self-check finding the PDF and gt.json the same.
async function expectPrinted(
  response: Response,
  pages: number,
  texts: [page: number, text: string][],
) {
  expect(
    response.status,
    response.status === 200 ? '' : await response.clone().text(),
  ).toBe(200);
  const body = (await response.json()) as {
    pageCount: number;
    pdf: string;
    gt: unknown;
  };
  expect(body.pageCount).toBe(pages);
  const gt = gtSchema.parse(body.gt);
  const read = gt.blocks.map(block => `${block.page} ${block.text}`);
  for (const [page, text] of texts) expect(read).toContain(`${page} ${text}`);
  const pdf = new Uint8Array(Buffer.from(body.pdf, 'base64'));
  expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
}

const onPages = (...pages: number[]) =>
  pages.flatMap(n =>
    expectedTexts(n).map(text => [n, text] as [number, string]),
  );

// Visible is the control: it printed before and must still print.
for (const visibility of ['auto', 'visible']) {
  test(`content-visibility: ${visibility} content on pages 2 and 3 prints with gt.json matching the PDF`, async () => {
    const body = `<section class="next">${structures(2)}</section>
      <section class="next">${structures(3)}</section>`;
    await expectPrinted(
      await post(document(body, visibility)),
      3,
      onPages(2, 3),
    );
  });

  test(`content-visibility: ${visibility} content near the bottom of page 1 prints with gt.json matching the PDF`, async () => {
    // Page 1 prints as before: the two structures whose size skipping
    // changes (an inline-block auto box in a line, an auto block of no
    // intrinsic size), from about 970px of page 1, still inside it with
    // auto's containment (which makes them taller than visible ones: a
    // tighter spacer leaves the last one in Paged.js's overflow column, and
    // the PDF loses it).
    const body = `<section><div class="spacer"></div>
      <p data-gt="paragraph">可見文字戊<span class="cv ib">隱藏文字己1</span></p>
      <p data-gt="paragraph" class="cv">自身段落丁1</p></section>`;
    await expectPrinted(await post(document(body, visibility)), 1, [
      [1, '可見文字戊隱藏文字己1'],
      [1, '自身段落丁1'],
    ]);
  });
}

// Each paragraph is 40 lines (960px): skipped while Paged.js paginated, all
// three were put on page 2, and in print they run past it.
test('content-visibility: auto content that grows past its page only in print is refused as print_overflow', async () => {
  const tall = [1, 2, 3]
    .map(
      k =>
        `<div class="cv"><p data-gt="paragraph">${Array.from(
          { length: 40 },
          (_, i) => `長段落${k}第${i}行`,
        ).join('<br>')}</p></div>`,
    )
    .join('');
  const response = await post(
    document(`<section class="next">${tall}</section>`, 'auto'),
  );
  expect(
    response.status,
    response.status === 200
      ? 'unexpected PDF success'
      : await response.clone().text(),
  ).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code, JSON.stringify(error)).toBe('print_overflow');
});
