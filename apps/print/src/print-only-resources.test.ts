import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { apiErrorSchema, gtSchema } from '@pdf-generator/contract';
import { getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

// A stylesheet that applies in print media only (`<style data-pagedjs-ignore
// media="print">`, or `@media print` in a data-pagedjs-ignore style) stays live
// after Paged.js. What it asks for (an image in `content: url()`, an <img>
// shown only in print, a font face) used to start loading only when print
// media was emulated after the PDF was printed: the PDF lacked it, while the
// ground truth was measured with it (T07-20 review round 3).
const token = 'print-only-resources-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
/** A real opaque RGB PNG of one colour. */
function png(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function document(head: string, body: string) {
  return `<!doctype html><html><head><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px sans-serif; }
    p { margin: 0; }
    </style>${head}</head><body>${body}</body></html>`;
}

async function post(
  html: string,
  files: Record<string, Uint8Array> = {},
  source = true,
) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      ...(source
        ? {
            source: {
              templateId: 'print-only',
              templateVersion: 1,
              seed: 'same',
              index: 0,
            },
          }
        : {}),
      pack: {
        template: 'index.html',
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [
            name,
            Buffer.from(bytes).toString('base64'),
          ]),
        ),
      },
    }),
  });
}

/**
 * How far below the bottom of the square's ground-truth box the PDF draws
 * AFTER's baseline, in pt. AFTER (not a data-gt block, so the text guard
 * can't refuse the print on its own) follows the square directly: where the
 * box and the PDF agree, this is a property of the font and line height alone.
 */
async function baselineBelowBox(response: Response) {
  const body = (await response.json()) as { gt: unknown; pdf: string };
  const gt = gtSchema.parse(body.gt);
  const block = gt.blocks.find(b => b.type === 'image');
  if (!block) throw new Error('missing the square image block');
  const pdf = await getDocumentProxy(
    new Uint8Array(Buffer.from(body.pdf, 'base64')),
  );
  try {
    const page = await pdf.getPage(block.page);
    const { items } = await page.getTextContent();
    const text = items.find(item => 'str' in item && item.str === 'AFTER');
    if (!text || !('str' in text)) throw new Error('missing printed AFTER');
    return (page.view[3] ?? 0) - text.transform[5] - block.bbox[3];
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const square =
  '<div data-gt="image" style="width:40px;height:40px;background:black"></div>';
const after = '<p>AFTER</p>';
const a = png(40, 80);

/** The same document with nothing print-only: GT and PDF agree by design. */
async function controlOffset() {
  const response = await post(
    document('', `<div class="pad"></div>${square}${after}`),
    { 'a.png': a },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return baselineBelowBox(response);
}

async function expectPrintedWhereGtSays(response: Response, control: number) {
  if (response.status === 422) {
    // Refusing is allowed; a wrong ground truth is not.
    apiErrorSchema.parse(await response.json());
    return;
  }
  expect(response.status).toBe(200);
  const offset = await baselineBelowBox(response);
  expect(
    Math.abs(offset - control),
    `PDF baseline ${offset} pt below the square's GT box, ${control} pt where they agree`,
  ).toBeLessThan(1);
}

// Regression: the reviewer's case. The print-only ::before image (80 px) moves
// the data-gt blocks below it by 60 pt in the PDF, but loaded only after the
// PDF was printed, so GT placed them 62 pt higher than the PDF draws them.
test.each([
  {
    name: '<style data-pagedjs-ignore media="print"> with content: url()',
    head: '<style data-pagedjs-ignore media="print">.pad::before { content: url(a.png); display: block; }</style>',
    body: `<div class="pad"></div>${square}${after}`,
  },
  {
    name: '@media print inside <style data-pagedjs-ignore> with content: url()',
    head: '<style data-pagedjs-ignore>@media print { .pad::before { content: url(a.png); display: block; } }</style>',
    body: `<div class="pad"></div>${square}${after}`,
  },
  {
    name: 'an <img> shown only in print',
    head: '<style>.pic { display: none; }</style><style data-pagedjs-ignore media="print">.pic { display: block; }</style>',
    body: `<img class="pic" src="a.png">${square}${after}`,
  },
])(
  'POST /print prints GT where the PDF draws it, or refuses: $name',
  async ({ head, body }) => {
    const control = await controlOffset();
    await expectPrintedWhereGtSays(
      await post(document(head, body), { 'a.png': a }),
      control,
    );
  },
);

// Regression: the face is declared in a print-only stylesheet, so it is not
// among the faces Paged.js lists on screen; its failure surfaced as
// text_missing, the symptom, instead of font_not_loaded, the cause.
const broken = new Uint8Array([0, 1, 2, 3, 4]);
const dataBroken = 'data:font/woff2;base64,AAECAwQ=';
test.each<{
  name: string;
  head: string;
  files: Record<string, Uint8Array>;
}>([
  {
    name: 'a broken pack file in a print-only style',
    head: `<style data-pagedjs-ignore media="print">@font-face { font-family: "Print Only TC"; src: url(bad.woff2) format("woff2"); } body { font-family: "Print Only TC", sans-serif; }</style>`,
    files: { 'bad.woff2': broken },
  },
  {
    name: 'a broken data: URL in a print-only style',
    head: `<style data-pagedjs-ignore media="print">@font-face { font-family: "Print Only TC"; src: url("${dataBroken}") format("woff2"); } body { font-family: "Print Only TC", sans-serif; }</style>`,
    files: {},
  },
  {
    name: 'a broken pack file under @media print in an ignored style',
    head: `<style data-pagedjs-ignore>@media print { @font-face { font-family: "Print Only TC"; src: url(bad.woff2) format("woff2"); } body { font-family: "Print Only TC", sans-serif; } }</style>`,
    files: { 'bad.woff2': broken },
  },
])(
  'POST /print refuses $name with font_not_loaded',
  async ({ head, files }) => {
    const response = await post(
      document(head, '<p data-gt="paragraph">AFTER 公司月報</p>'),
      files,
      false,
    );
    expect(response.status).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('font_not_loaded');
    expect(JSON.stringify(error.details)).toContain('Print Only TC');
  },
);
