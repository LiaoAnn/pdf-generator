// T08-8: content-visibility: hidden skips its element's contents: Chrome
// lays them out (they have client rects) but paints none of them, so a
// data-gt block (or anything inside one) there would be described in gt.json
// and missing from the PDF. Probed on local Chromium (the real web → print
// pipeline): text there was refused as text_missing (with a font-shaped
// explanation), a decoration-only block printed nothing yet kept its gt box,
// and a visible block's descendant inside a hidden container stretched the
// block's gt box over ink that never printed, with the self-check passing.
// Print refuses all of these as content_clipped instead. The hidden element's
// own box (its background and borders) still paints, so a hidden block with
// nothing inside prints as gt.json describes it; content-visibility visible
// and auto paint everything.
import { apiErrorSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'content-hidden-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

function document(body: string, visibility: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px "Noto Sans TC"; }
    p { margin: 0 0 8px; }
    .cv { content-visibility: ${visibility}; }
    .sized { height: 48px; }
    .ib { display: inline-block; }
    .box { width: 80px; height: 40px; background: black; }
    .frame { width: 120px; height: 48px; border: 2px solid black; }
    .kid { width: 40px; height: 20px; background: black; }
    .host { position: relative; width: 200px; height: 30px; }
    .below { position: absolute; left: 0; top: 40px; width: 100px; height: 40px; }
    .fill { height: 100%; background: black; }
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
    }),
  });
}
async function expectHidden(response: Response, page: number) {
  expect(
    response.status,
    response.status === 200
      ? 'unexpected PDF success'
      : await response.clone().text(),
  ).toBe(422);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code, JSON.stringify(error)).toBe('content_clipped');
  expect(
    error.details?.some(detail =>
      new RegExp(`^page ${page} \\S+ inside content-visibility: hidden$`).test(
        detail.message,
      ),
    ),
    JSON.stringify(error.details),
  ).toBe(true);
}
async function expectPdf(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/application\/pdf/);
}

// Every structure the probe found printing differently from its gt.json.
const unprinted = [
  {
    name: 'data-gt text inside a sized hidden ancestor',
    body: '<div class="cv sized"><p data-gt="paragraph">隱藏的段落文字</p></div>',
  },
  {
    name: 'data-gt text inside an unsized hidden ancestor',
    body: '<div class="cv"><p data-gt="paragraph">隱藏的段落文字</p></div>',
  },
  {
    name: 'a hidden data-gt block holding text',
    body: '<p data-gt="paragraph" class="cv sized">隱藏的段落文字</p>',
  },
  {
    name: 'a hidden inline-block holding part of a data-gt text',
    body: '<p data-gt="paragraph">看得見的文字<span class="cv ib">隱藏的文字</span></p>',
  },
  {
    name: 'a decoration-only data-gt block inside a hidden ancestor',
    body: '<div class="cv sized"><div data-gt="image" class="box"></div></div>',
  },
  {
    name: "a visible data-gt block's descendant ink inside a hidden container",
    body: '<div data-gt="paragraph" class="host">看得見的文字<div class="cv below"><div class="fill"></div></div></div>',
  },
  {
    name: "a visible data-gt block's descendant SVG inside a hidden container",
    body: '<div data-gt="image" class="host box"><div class="cv below"><svg width="100" height="40"><rect width="100" height="40" fill="black"/></svg></div></div>',
  },
  {
    name: 'a hidden bordered data-gt block with a decoration inside',
    body: '<div data-gt="image" class="cv frame"><div class="kid"></div></div>',
  },
];

test.each(unprinted)(
  'refuses $name as content_clipped instead of describing what never prints',
  async ({ body }) => {
    await expectHidden(await post(document(body, 'hidden')), 1);
  },
);

test('reports the page of hidden data-gt content on the second page', async () => {
  await expectHidden(
    await post(
      document(
        '<div class="next"><p data-gt="paragraph">第二頁</p><div class="cv sized"><div data-gt="image" class="box"></div></div></div>',
        'hidden',
      ),
    ),
    2,
  );
});

// content-visibility: auto skips off-screen contents on screen, and page 2
// lies below the viewport while print measures, yet the PDF paints them:
// they are not hidden content and must not be refused as such.
test('prints decoration inside content-visibility: auto on the second page', async () => {
  await expectPdf(
    await post(
      document(
        '<div class="next"><p data-gt="paragraph">第二頁</p><div class="cv sized"><div data-gt="image" class="box"></div></div><div class="cv"><div data-gt="image" class="frame"><div class="kid"></div></div></div></div>',
        'auto',
      ),
    ),
  );
});

// SVG parts that render no box of their own (definitions, a gradient's
// stops, a clip path, a title) are not hidden content.
test('prints an inline SVG with definitions in a visible data-gt block', async () => {
  await expectPdf(
    await post(
      document(
        '<div data-gt="image"><svg width="100" height="40"><title>圖</title><defs><linearGradient id="g"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="gray"/></linearGradient><clipPath id="c"><rect width="90" height="40"/></clipPath></defs><rect width="100" height="40" fill="url(#g)" clip-path="url(#c)"/></svg></div>',
        'hidden',
      ),
    ),
  );
});

// The hidden element's own box paints: with nothing (or only whitespace)
// inside, the PDF shows the border gt.json describes.
test.each([
  { name: 'empty', body: '<div data-gt="image" class="cv frame"></div>' },
  {
    name: 'whitespace-only',
    body: '<div data-gt="image" class="cv frame">\n  \n</div>',
  },
])(
  'prints a hidden bordered data-gt block with $name contents',
  async ({ body }) => {
    await expectPdf(await post(document(body, 'hidden')));
  },
);

// Controls: the same structures print when their contents are painted.
test.each(
  ['visible', 'auto'].flatMap(visibility =>
    unprinted.map(({ name, body }) => ({ visibility, name, body })),
  ),
)(
  'prints $name with content-visibility: $visibility',
  async ({ visibility, body }) => {
    await expectPdf(await post(document(body, visibility)));
  },
);
