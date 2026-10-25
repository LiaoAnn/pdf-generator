import { Buffer } from 'node:buffer';
import { apiErrorSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'print-overflow-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

const paragraphs = Array.from(
  { length: 6 },
  (_, i) =>
    `<p class="b" data-gt="paragraph">B${i} aaaa bbbb cccc dddd eeee ffff gggg</p>`,
).join('');
const image = '<div class="b" data-gt="image"></div>';
const grow = 'body .b.b { line-height: 96px !important; }';
// An inline block cannot fragment into Paged.js's next hidden column, so
// this fixture independently exercises bottom overflow rather than right.
const tall =
  'body .b.b { height: 1200px !important; display: inline-block; vertical-align: top; }';
const ignored = (css: string) =>
  `<style data-pagedjs-ignore>@media print { ${css} }</style>`;

function document(body: string, head = '', css = '') {
  return `<!doctype html><html><head><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px "Noto Sans TC"; }
    .b { width: 60mm; margin: 0; } div.b { height: 40px; background: black; }
    ${css}</style>${head}</head><body>${body}</body></html>`;
}

async function post(html: string, css?: string) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      // Deliberately omit source: refusal must also protect PDF-only callers.
      ...(css === undefined
        ? {}
        : {
            pack: {
              template: 'index.html',
              files: { 'overflow.css': Buffer.from(css).toString('base64') },
            },
          }),
    }),
  });
}

async function expectError(response: Response, code: string) {
  expect(
    response.status,
    response.status === 200
      ? 'unexpected PDF success'
      : await response.clone().text(),
  ).toBe(422);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe(code);
  return error;
}

test.each([
  { name: 'ignored @media print style', head: ignored(grow), body: paragraphs },
  {
    name: 'ignored linked pack stylesheet',
    head: '<link rel="stylesheet" data-pagedjs-ignore href="overflow.css">',
    body: paragraphs,
    css: `@media print { ${grow} }`,
  },
  {
    name: 'ignored style media=print',
    head: `<style media="print" data-pagedjs-ignore>${grow}</style>`,
    body: paragraphs,
  },
  {
    name: 'body style left live by Paged.js',
    head: '',
    body: `<style>@media print { ${grow} }</style>${paragraphs}`,
  },
])(
  '$name reports print_overflow before text_missing with page, tag and hidden-column excess',
  async fixture => {
    const error = await expectError(
      await post(document(fixture.body, fixture.head), fixture.css),
      'print_overflow',
    );
    expect(
      error.details?.some(detail =>
        /page 1 p \d+\.\d+px right of its content area/.test(detail.message),
      ),
      JSON.stringify(error.details),
    ).toBe(true);
  },
);

test('textless data-gt box growing below the page is refused without relying on PDF text', async () => {
  const error = await expectError(
    await post(document(image, ignored(tall))),
    'print_overflow',
  );
  expect(
    error.details?.some(detail =>
      /page 1 div \d+\.\d+px below its content area/.test(detail.message),
    ),
  ).toBe(true);
  const detail = error.details?.find(detail =>
    /page 1 div/.test(detail.message),
  );
  const excess = Number(detail?.message.match(/(\d+\.\d+)px below/)?.[1]);
  expect(Math.abs(excess - (1200 - (257 * 96) / 25.4))).toBeLessThan(0.5);
});

test('unmarked descendant overflowing right is refused even when its data-gt parent stays inside', async () => {
  const error = await expectError(
    await post(
      document(
        '<div data-gt="image" style="width:40px;height:40px"><span class="child" style="display:block;width:20px;height:20px;background:black"></span></div>',
        ignored('body .child.child { width: 2000px !important; }'),
      ),
    ),
    'print_overflow',
  );
  expect(
    error.details?.some(detail =>
      /page 1 span \d+\.\d+px right of its content area/.test(detail.message),
    ),
  ).toBe(true);
});

test.each([
  { excess: 0.25, status: 200 },
  { excess: 0.75, status: 422 },
])(
  'right overflow of $excess CSS px respects the 0.5px tolerance',
  async ({ excess, status }) => {
    const response = await post(
      document(
        image,
        ignored(`body .b.b { width: calc(170mm + ${excess}px) !important; }`),
      ),
    );
    if (status === 422) {
      const error = await expectError(response, 'print_overflow');
      expect(
        error.details?.some(detail =>
          /right of its content area/.test(detail.message),
        ),
      ).toBe(true);
    } else {
      expect(response.status, await response.clone().text()).toBe(200);
      await response.arrayBuffer();
    }
  },
);

test.each([
  {
    name: 'a tall block already outside on screen',
    css: 'div.b { height: 1200px; }',
    print: '',
  },
  {
    name: 'print-only shrinking',
    css: '',
    print: 'body .b.b { width: 20px; height: 20px; }',
  },
  {
    name: 'print-only colour',
    css: '',
    print: 'body .b.b { background: red; }',
  },
])('$name is not a new print overflow', async fixture => {
  const response = await post(
    document(image, ignored(fixture.print), fixture.css),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await response.arrayBuffer();
});

// Each competing fixture also contains a newly overflowing textless block.
// These catch moving the new guard ahead of the established refusal.
test.each([
  {
    code: 'row_fragmented',
    body: `${image}<table data-gt="table"><tr><td>ROW</td></tr></table>`,
    head: ignored(`${tall} tr { position: relative; left: 180mm; }`),
  },
  {
    code: 'page_box_moved',
    body: image,
    head: ignored(
      `${tall} .pagedjs_page_content { position: relative; left: -5mm; }`,
    ),
  },
  {
    code: 'page_count_mismatch',
    body: `<div style="height:10px;break-after:page"></div><template data-ref="pagedjs-content">${image}</template>`,
    head: ignored(tall),
  },
  {
    code: 'css_animation',
    body: image,
    head: ignored(
      `${tall} @keyframes pulse { from { opacity: 0.2; } to { opacity: 0.8; } } body .b.b { animation: pulse 999s infinite; }`,
    ),
  },
  {
    code: 'font_not_loaded',
    body: `${image}<p data-gt="paragraph">FONT</p>`,
    head: ignored(
      `${tall} @font-face { font-family: "Broken Print"; src: url("data:font/woff2;base64,AAECAwQ=") format("woff2"); } body p { font-family: "Broken Print"; }`,
    ),
  },
  {
    code: 'viewport_dependent',
    body: image,
    head: ignored(
      `${tall} @media (min-width: 794px) { body .b.b { width: 100px !important; } }`,
    ),
  },
])(
  '$code keeps precedence over a simultaneous print overflow',
  async fixture => {
    await expectError(
      await post(document(fixture.body, fixture.head)),
      fixture.code,
    );
  },
);
