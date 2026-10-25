import { URL } from 'node:url';
import { apiErrorSchema, gtSchema } from '@pdf-generator/contract';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'final-fixes-local-test-token';
let worker: PrintWorker;
const source = {
  templateId: 'monthly-report',
  templateVersion: 3,
  seed: 'final-fixes_42',
  index: 7,
};

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function documentHtml(body: string, css = '') {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
  <style>@page { margin: 20mm; } body { margin: 0; font: 16px "Noto Sans TC"; }
  ${css}</style></head><body>${body}</body></html>`;
}

async function post(body: unknown) {
  // Native fetch avoids the RPC body limit for complete template documents.
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function print(html: string) {
  return post({ html, page: { size: 'A4', orientation: 'portrait' } });
}

async function expectMissingText(response: Response, page: number) {
  expect(response.status).toBe(422);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('text_missing');
  expect(
    error.details?.some(detail => detail.message === `page ${page}: ——`),
    JSON.stringify(error.details),
  ).toBe(true);
}

test('template script cannot forge ready state to bypass the authoritative PDF text check', async () => {
  const response = await print(
    documentHtml(`<p data-gt="lossy">——</p>
    <script>window.__pdfgen.ready = Promise.resolve({ pageCount: 999,
    unloadedFaces: [], fragmentedRows: [], expectedText: [] });</script>`),
  );
  await expectMissingText(response, 1);
});

test.each([
  ['U+00A0', '\u00a0'],
  ['U+FEFF', '\ufeff'],
  ['U+000B', '\u000b'],
  ['leading HTML comment', '<!-- generated template -->'],
])(
  '%s before the doctype cannot let template scripts forge ready state',
  async (_name, prefix) => {
    const response = await print(
      prefix +
        documentHtml(`<p data-gt="paragraph">標點——測試</p>
    <script>window.__pdfgen.ready = Promise.resolve({ pageCount: 999,
    unloadedFaces: [], fragmentedRows: [], expectedText: [] });</script>`),
    );
    expect(response.status).toBe(422);
    expect(response.headers.has('x-page-count')).toBe(false);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('text_missing');
    expect(error.details?.some(detail => detail.message.includes('——'))).toBe(
      true,
    );
  },
);

test('comments and HTML whitespace before the doctype preserve standards-mode class matching', async () => {
  const response = await print(
    ' \t\r\n<!-- generated template -->\n<!-- second comment -->\f' +
      documentHtml(
        '<p class="HIDDEN" data-gt="paragraph">重要內容</p>',
        '.hidden { display: none; }',
      ),
  );
  expect(response.status).toBe(200);
  const pdf = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text.replace(/\s/gu, '')).toBe('重要內容');
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('template pagedjs_page markup cannot shift the generated page text checks', async () => {
  const response = await print(
    documentHtml(
      '<div id="template-page" class="pagedjs_page"><p data-gt="paragraph">公司月報</p></div>',
      // Keep the colliding class from importing Paged.js page-box dimensions.
      '#template-page { all: initial; display: block; font: inherit; }',
    ),
  );
  expect(
    response.status,
    response.status === 200 ? undefined : await response.text(),
  ).toBe(200);
  expect(response.headers.get('x-page-count')).toBe('1');
  const pdf = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    expect(pdf.numPages).toBe(1);
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text.replace(/\s/gu, '')).toBe('公司月報');
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test.each([
  {
    name: 'inline scripts and image/body event handlers',
    html: documentHtml(`<p data-gt="normal">一月公司月報</p>
      <script>document.body.append('INLINE_INJECTED');</script>
      <img src="data:image/png,broken" onerror="document.body.append('ERROR_INJECTED')">`).replace(
      '<body>',
      '<body onload="document.body.append(\'LOAD_INJECTED\')">',
    ),
  },
  {
    name: 'external script URLs',
    // A script src is an external script even with a self-contained data URL:
    // its payload is executable without contacting any real external service.
    html: documentHtml(`<p data-gt="normal">一月公司月報</p>
      <script src="data:text/javascript,document.body.append('EXTERNAL_INJECTED')"></script>`),
  },
])(
  '$name cannot add text while normal template content still prints',
  async ({ html }) => {
    const response = await print(html);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/pdf\b/i,
    );
    const pdf = await getDocumentProxy(
      new Uint8Array(await response.arrayBuffer()),
    );
    try {
      expect(pdf.numPages).toBe(1);
      expect(response.headers.get('x-page-count')).toBe('1');
      const { text } = await extractText(pdf, { mergePages: true });
      expect(text.replace(/\s/gu, '')).toBe('一月公司月報');
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);

test.each([
  {
    name: 'margin-box font shorthand',
    css: '@page { @bottom-center { content: "月報"; font: 16px "Noto Serif TC"; } }',
    fonts: ['NotoSansTC-Regular', 'NotoSerifTC-Regular'],
  },
  {
    name: 'print-media font-family override',
    css: 'body { font: 16px "Noto Sans TC", sans-serif; } @media print { body { font-family: "Noto Serif TC", serif; } }',
    fonts: ['NotoSerifTC-Regular'],
  },
  ...['only print', 'screen, print', 'print and (min-width: 1px)'].map(
    query => ({
      name: `print-media query "${query}"`,
      css: `@media ${query} { body { font-family: "Noto Serif TC", serif; } }`,
      fonts: ['NotoSerifTC-Regular'],
    }),
  ),
])(
  '$name embeds the requested face even with a box-neutral size media query',
  async ({ css, fonts }) => {
    const response = await print(documentHtml('<p data-gt="t">月報</p>', css));
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const raw = Buffer.from(bytes).toString('latin1');
    const embedded = [
      ...new Set(
        [...raw.matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g)].map(match =>
          (match[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
        ),
      ),
    ];
    expect(embedded.sort()).toEqual([...fonts].sort());
    expect(raw).toMatch(/\/FontFile[23]?\b/);
  },
);

test('PDF text check visits later data-gt blocks on page 2 after intact first nodes on both pages', async () => {
  const response = await print(
    documentHtml(
      `
    <section><p data-gt="one">第一頁完整文字</p></section>
    <section><p data-gt="two">第二頁完整文字</p>
    <p data-gt="later">——</p></section>`,
      'section + section { break-before: page; }',
    ),
  );
  await expectMissingText(response, 2);
});

test.each(['portrait', 'landscape'] as const)(
  'source opts into contract-valid ground truth matching the %s PDF pages in points',
  async orientation => {
    const response = await post({
      html: documentHtml(
        '<section><h1 data-gt="title">公司月報</h1></section><section><p data-gt="paragraph">第二頁內容</p></section>',
        'section + section { break-before: page; }',
      ),
      page: { size: 'A4', orientation },
      source,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/json\b/i,
    );
    const body = (await response.json()) as {
      pageCount: number;
      pdf: string;
      gt: unknown;
    };
    const gt = gtSchema.parse(body.gt);
    expect(gt.source).toEqual(source);
    expect(
      gt.blocks.map(({ type, text, page }) => ({ type, text, page })),
    ).toEqual([
      { type: 'title', text: '公司月報', page: 1 },
      { type: 'paragraph', text: '第二頁內容', page: 2 },
    ]);
    for (const block of gt.blocks) {
      const page = gt.pages[block.page - 1];
      expect(page).toBeDefined();
      const [x0, y0, x1, y1] = block.bbox;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
      expect(x1).toBeLessThanOrEqual(page?.width ?? 0);
      expect(y1).toBeLessThanOrEqual(page?.height ?? 0);
    }
    expect(body.pageCount).toBe(2);
    expect(gt.pages).toHaveLength(body.pageCount);
    expect(response.headers.get('x-page-count')).toBe(String(body.pageCount));
    expect(typeof body.pdf).toBe('string');
    const bytes = new Uint8Array(Buffer.from(body.pdf, 'base64'));
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    const pdf = await getDocumentProxy(bytes);
    try {
      expect(pdf.numPages).toBe(body.pageCount);
      for (let n = 1; n <= pdf.numPages; n++) {
        const [x0, y0, x1, y1] = (await pdf.getPage(n)).view;
        const width = orientation === 'portrait' ? 595.28 : 841.89;
        const height = orientation === 'portrait' ? 841.89 : 595.28;
        const page = gt.pages[n - 1];
        expect(page).toBeDefined();
        expect(Math.abs((page?.width ?? 0) - width)).toBeLessThan(1);
        expect(Math.abs((page?.height ?? 0) - height)).toBeLessThan(1);
        expect(
          Math.abs((x1 ?? 0) - (x0 ?? 0) - (page?.width ?? 0)),
        ).toBeLessThan(1);
        expect(
          Math.abs((y1 ?? 0) - (y0 ?? 0) - (page?.height ?? 0)),
        ).toBeLessThan(1);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);

test('invalid ground-truth block type returns 422 ground_truth_invalid with reader issues when source is requested', async () => {
  const response = await post({
    html: documentHtml('<p data-gt="not-a-block-type">公司月報</p>'),
    page: { size: 'A4', orientation: 'portrait' },
    source,
  });
  expect(response.status).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('ground_truth_invalid');
  expect(error.details).toEqual([
    {
      message:
        'data-gt="not-a-block-type" on page 1: unknown block type "not-a-block-type"',
    },
  ]);
});

test('invalid ground-truth block type still prints a PDF when source is omitted', async () => {
  const response = await print(
    documentHtml('<p data-gt="not-a-block-type">公司月報</p>'),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/i);
  const pdf = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    expect(pdf.numPages).toBe(1);
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text.replace(/\s/gu, '')).toBe('公司月報');
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test.each([
  ['null', null],
  [
    'missing field',
    { templateId: 'monthly-report', templateVersion: 1, seed: 'seed' },
  ],
  ['invalid slug', { ...source, templateId: '../report' }],
  ['invalid version', { ...source, templateVersion: 0 }],
  ['invalid seed', { ...source, seed: 'has spaces' }],
  ['invalid index', { ...source, index: -1 }],
  ['unknown field', { ...source, extra: true }],
])(
  'invalid source (%s) returns invalid_request before rendering',
  async (_name, invalid) => {
    const response = await post({
      html: documentHtml('<p data-gt="t">月報</p>'),
      page: { size: 'A4', orientation: 'portrait' },
      source: invalid,
    });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      'invalid_request',
    );
  },
);
