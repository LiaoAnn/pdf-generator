import { URL } from 'node:url';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'slice-two-local-test-token';
let worker: PrintWorker;
let unconfigured: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  unconfigured = await startPrintWorker();
  await Promise.all([worker.url, unconfigured.url]);
});

afterAll(async () => {
  await Promise.all([worker?.dispose(), unconfigured?.dispose()]);
});

const portrait = { size: 'A4', orientation: 'portrait' } as const;
const documentHtml = (css: string, body: string) =>
  `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><style>
  @page { margin: 20mm; } body { margin: 0; font-size: 16px; }
  ${css}</style></head><body>${body}</body></html>`;

async function post(
  body: string,
  authorization: string | undefined = `Bearer ${token}`,
  target = worker,
) {
  return target.fetch(new URL('/print', (await target.url).href), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body,
  });
}

async function expectApiError(
  response: Awaited<ReturnType<PrintWorker['fetch']>>,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

// Each fixture also rejects fallback fonts: a visually identical system CJK
// face must not silently replace the bundled, cmap-patched font (T03 §2.3–2.5).
test.each([
  {
    name: 'portrait keeps both forced pages and patched sans text',
    orientation: 'portrait',
    html: documentHtml(
      'body { font-family: "Noto Sans TC"; } section + section { break-before: page; }',
      '<section data-gt="one">一月公司月報</section><section data-gt="two" style="font-weight:700">第二頁人員名冊</section>',
    ),
    text: '一月公司月報第二頁人員名冊',
    pages: 2,
    fonts: ['NotoSansTC-Bold', 'NotoSansTC-Regular'],
  },
  {
    name: 'landscape overrides document page CSS and embeds only regular serif',
    orientation: 'landscape',
    html: documentHtml(
      '@page { size: A4 portrait; } body { font-family: "Noto Sans TC"; } p { font-family: "Noto Serif TC"; }',
      '<p data-gt="report">一月財務報表</p><div style="font-family: \'LXGW WenKai TC\'; font-weight:700"> </div>',
    ),
    text: '一月財務報表',
    pages: 1,
    fonts: ['NotoSerifTC-Regular'],
  },
  {
    name: 'pseudo-element text loads its WenKai face without body text',
    orientation: 'portrait',
    html: documentHtml(
      'body { font-family: "Noto Sans TC"; } .label::before { content: "一月工作紀錄"; font-family: "LXGW WenKai TC"; }',
      '<div class="label" data-gt="label"></div>',
    ),
    text: '一月工作紀錄',
    pages: 1,
    fonts: ['LXGWWenKaiTC-Regular'],
  },
  {
    name: 'page margin text loads bold serif named only in an @page rule',
    orientation: 'portrait',
    html: documentHtml(
      'body { font-family: "Noto Sans TC"; } @page { @top-center { content: "一月頁首"; font-family: "Noto Serif TC"; font-weight: 700; } }',
      '<p data-gt="body">公司資料</p>',
    ),
    text: '一月頁首公司資料',
    pages: 1,
    fonts: ['NotoSansTC-Regular', 'NotoSerifTC-Bold'],
  },
  {
    name: 'weight 600 selects bold sans and checkbox glyphs use Symbols 2',
    orientation: 'portrait',
    html: documentHtml(
      'body { font-family: "Noto Sans TC"; font-weight:600; } .symbols { font-family: "Noto Sans Symbols 2"; font-weight:400; }',
      '<p data-gt="answer">一月確認<span class="symbols">☑☐</span></p>',
    ),
    text: '一月確認☑☐',
    pages: 1,
    fonts: ['NotoSansSymbols2-Regular', 'NotoSansTC-Bold'],
  },
] as const)('$name', async fixture => {
  const response = await post(
    JSON.stringify({
      html: fixture.html,
      page: { size: 'A4', orientation: fixture.orientation },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/i);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    expect(pdf.numPages).toBe(fixture.pages);
    expect(response.headers.get('x-page-count')).toBe(String(pdf.numPages));
    for (let n = 1; n <= pdf.numPages; n++) {
      const [x0, y0, x1, y1] = (await pdf.getPage(n)).view;
      const width = fixture.orientation === 'portrait' ? 595.28 : 841.89;
      const height = fixture.orientation === 'portrait' ? 841.89 : 595.28;
      expect(Math.abs((x1 ?? 0) - (x0 ?? 0) - width)).toBeLessThan(1);
      expect(Math.abs((y1 ?? 0) - (y0 ?? 0) - height)).toBeLessThan(1);
    }
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text.replace(/\s/gu, '')).toBe(fixture.text);
    const raw = Buffer.from(bytes).toString('latin1');
    const fonts = [
      ...new Set(
        [...raw.matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g)].map(match =>
          (match[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
        ),
      ),
    ];
    expect(fonts.sort()).toEqual([...fixture.fonts].sort());
    expect(raw).toMatch(/\/FontFile[23]?\b/);
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test.each([
  ['missing', ''],
  ['wrong token', 'Bearer wrong-token'],
  ['non-bearer', `Basic ${token}`],
])('rejects %s credentials with a contract API error', async (_name, auth) => {
  await expectApiError(
    await post(JSON.stringify({ html: '<html></html>', page: portrait }), auth),
    401,
    'unauthorized',
  );
});

test.each([
  ['valid bearer', `Bearer ${token}`],
  ['missing bearer', ''],
])('fails closed without PRINT_TOKEN even with %s', async (_name, auth) => {
  await expectApiError(
    await post(
      JSON.stringify({ html: '<html></html>', page: portrait }),
      auth,
      unconfigured,
    ),
    503,
    'not_configured',
  );
});

test.each([
  ['malformed JSON', '{'],
  ['null body', 'null'],
  ['missing html', JSON.stringify({ page: portrait })],
  ['non-string html', JSON.stringify({ html: 42, page: portrait })],
  ['missing page', JSON.stringify({ html: '<html></html>' })],
  [
    'unsupported size',
    JSON.stringify({
      html: '<html></html>',
      page: { size: 'Letter', orientation: 'portrait' },
    }),
  ],
  [
    'unsupported orientation',
    JSON.stringify({
      html: '<html></html>',
      page: { size: 'A4', orientation: 'sideways' },
    }),
  ],
])('rejects %s before rendering with invalid_request', async (_name, body) => {
  await expectApiError(await post(body), 400, 'invalid_request');
});
