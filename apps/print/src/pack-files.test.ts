import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import {
  apiErrorSchema,
  manifestSchema,
} from '../../../packages/contract/src/index.ts';
import { fill } from '../../../packages/template-tools/src/index.ts';

const token = 'pack-files-local-test';
const page = { size: 'A4', orientation: 'portrait' } as const;
const html =
  '<!doctype html><html><body><p data-gt="text">PACK ORIGINAL</p></body></html>';
const encode = (value: string | Uint8Array) =>
  Buffer.from(value).toString('base64');
const minimal = (files: Record<string, string> = {}) => ({
  html,
  page,
  pack: { template: 'templates/report.hbs', files },
});
type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;
let worker: Worker;
let valid: Omit<ReturnType<typeof minimal>, 'page'> & {
  page: { size: 'A4'; orientation: 'portrait' | 'landscape' };
};

beforeAll(async () => {
  const root = new URL(
    '../../../packages/template-tools/fixtures/valid/',
    import.meta.url,
  );
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(fileURLToPath(root), path)] = encode(await readFile(path));
  }
  const manifest = manifestSchema.parse(
    JSON.parse(Buffer.from(files['manifest.json'] ?? '', 'base64').toString()),
  );
  const template = Buffer.from(
    files[manifest.files.template] ?? '',
    'base64',
  ).toString();
  const sample = JSON.parse(
    Buffer.from(files[manifest.files.sample] ?? '', 'base64').toString(),
  );
  valid = {
    html: fill(template, sample),
    page: manifest.page,
    pack: { template: manifest.files.template, files },
  };
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    bindings: { PRINT_TOKEN: { type: 'plain_text', value: token } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false },
  });
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function error(
  response: Awaited<ReturnType<typeof post>>,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  const parsed = apiErrorSchema.parse(await response.json()).error;
  expect(parsed.code).toBe(code);
  return parsed;
}

async function pdf(response: Awaited<ReturnType<typeof post>>) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  return getDocumentProxy(new Uint8Array(await response.arrayBuffer()));
}

// Regression: ignoring pack files or resolving linked CSS/font URLs against
// /blank silently prints the platform's fallback font instead of the pack face.
test('T06 valid pack prints sample text with its own loaded and embedded WenKai font', async () => {
  const font = await readFile(
    new URL('./test-fixtures/pack-font/report.woff2', import.meta.url),
  );
  const document = await pdf(
    await post({
      ...valid,
      pack: {
        ...valid.pack,
        files: { ...valid.pack.files, 'assets/report.woff2': encode(font) },
      },
    }),
  );
  try {
    const { text } = await extractText(document, { mergePages: true });
    const normalized = text.normalize('NFKC').replace(/\s/gu, '');
    for (const expected of [
      '公司月報',
      '青禾有限公司',
      '24536806',
      '王小明',
      'A123456789',
      '100臺北市中正區中山路10號3樓',
      '02-2345-6789',
      '2026-10-01',
      '125,000',
      '已核准',
      '文具',
      '2,500',
      '設備',
      '12,000',
      '本報表為測試用合成資料。',
    ]) {
      expect(normalized).toContain(expected.normalize('NFKC'));
    }
    const raw = Buffer.from(await document.getData()).toString('latin1');
    expect(raw).toMatch(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?LXGWWenKaiTC[^\s/<>]*/);
    expect(raw).toMatch(/\/FontFile[23]?\b/);
  } finally {
    await document.loadingTask.destroy();
  }
});

// Regression: checking only platform fonts permits a broken pack font to fall back.
test('the original placeholder pack font fails with font_not_loaded', async () => {
  const result = await error(await post(valid), 422, 'font_not_loaded');
  expect(JSON.stringify(result.details)).toContain('Report Sans');
});

// A genuine 1x1 PNG. Four placements independently pin each relative-URL base;
// PDF image operators prove that fetching an image actually affected printing.
// Non-repeating backgrounds avoid PDF tiling patterns, whose image operators
// live in pattern resources rather than the page's operator list.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQMgkDAAD4AJ3MaiF4AAAAAElFTkSuQmCC';
test.each([
  ['img src', '<img width="32" height="32" src="../assets/pixel.png">', ''],
  [
    'inline style element',
    '<style>.picture { background:url("../assets/pixel.png") no-repeat; background-size:32px 32px }</style><div class="picture"></div>',
    '',
  ],
  [
    'style attribute',
    '<div style="background:url(\'../assets/pixel.png\') no-repeat; background-size:32px 32px"></div>',
    '',
  ],
  [
    'linked stylesheet',
    '<link rel="stylesheet" href="../styles/nested/image.css"><div class="picture"></div>',
    '.picture { background:url("../../assets/pixel.png") no-repeat; background-size:32px 32px }',
  ],
])(
  'resolves %s relative to its pack document or stylesheet',
  async (_name, content, css) => {
    const request = minimal({
      'assets/pixel.png': png,
      'styles/nested/image.css': encode(css),
    });
    const split = content.indexOf('<div');
    const head =
      content.startsWith('<link') || content.startsWith('<style')
        ? content.slice(0, split)
        : '';
    const body = head ? content.slice(split) : content;
    request.html = `<!doctype html><html><head><style>div { width:32px; height:32px }</style>${head}</head><body>${body}</body></html>`;
    const document = await pdf(await post(request));
    try {
      const operators = await (await document.getPage(1)).getOperatorList();
      const { OPS } = await getResolvedPDFJS();
      expect(
        operators.fnArray.some(op =>
          [
            OPS.paintImageXObject,
            OPS.paintInlineImageXObject,
            OPS.paintImageMaskXObject,
          ].includes(op),
        ),
      ).toBe(true);
    } finally {
      await document.loadingTask.destroy();
    }
  },
);

// Regression: script-src 'self' allows newly hosted, same-origin pack scripts.
test('a script hosted in pack files cannot change the printed data-gt text', async () => {
  const request = minimal({
    'assets/x.js': encode(
      'document.querySelector("[data-gt]").textContent = "PACK MUTATED";',
    ),
  });
  request.html = html.replace(
    '</body>',
    '<script src="../assets/x.js"></script></body>',
  );
  const document = await pdf(await post(request));
  try {
    const { text } = await extractText(document, { mergePages: true });
    expect(text).toContain('PACK ORIGINAL');
    expect(text).not.toContain('PACK MUTATED');
  } finally {
    await document.loadingTask.destroy();
  }
});

// Regression: testing encoded string length rejects valid packs below the
// decoded cap; >= rather than > incorrectly rejects the exact limits.
test('accepts exactly 16 MiB in one file and 24 MiB total decoded', async () => {
  const response = await post(
    minimal({
      'assets/one.bin': encode(Buffer.alloc(16 * 1024 * 1024)),
      'assets/two.bin': encode(Buffer.alloc(8 * 1024 * 1024)),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  await response.arrayBuffer();
});

test.each([
  [
    'one file',
    () => ({ 'assets/large.bin': encode(Buffer.alloc(16 * 1024 * 1024 + 1)) }),
    /assets\/large\.bin/,
  ],
  [
    'total',
    () => ({
      'assets/a.bin': encode(Buffer.alloc(12 * 1024 * 1024)),
      'assets/b.bin': encode(Buffer.alloc(12 * 1024 * 1024 + 1)),
    }),
    /total/i,
  ],
] as const)(
  'rejects decoded %s overflow with a useful pack_too_large diagnostic',
  async (_name, files, diagnostic) => {
    const result = await error(
      await post(minimal(files())),
      413,
      'pack_too_large',
    );
    expect(JSON.stringify(result.details)).toMatch(diagnostic);
  },
);

test('rejects Content-Length over 40 MiB before attempting to parse malformed JSON', async () => {
  await error(
    await post(`{${' '.repeat(40 * 1024 * 1024)}`, {
      'content-length': String(40 * 1024 * 1024 + 1),
    }),
    413,
    'pack_too_large',
  );
});

// These route checks must reject bad pack data even once `pack` is supported.
test.each([
  '../escape',
  '/absolute',
  'assets/../escape',
  'assets//x',
  'assets\\x',
  'assets/./x',
  'assets/\u0000x',
  '',
])('rejects invalid pack file path %j', async path => {
  await error(
    await post(minimal({ [path]: encode('x') })),
    400,
    'invalid_request',
  );
});
test.each(['../escape.hbs', '/report.hbs', 'templates/./report.hbs'])(
  'rejects invalid pack template path %j',
  async template => {
    const request = minimal();
    request.pack.template = template;
    await error(await post(request), 400, 'invalid_request');
  },
);
test.each(['not base64!', 'YQ=', 'Y===', 'YQ==\n', '-_8=', 42, null])(
  'rejects non-base64 pack bytes %j',
  async value => {
    const request = {
      html,
      page,
      pack: {
        template: 'templates/report.hbs',
        files: { 'assets/x.bin': value },
      },
    };
    await error(await post(request), 400, 'invalid_request');
  },
);

test('unknown pack ids and unknown paths are not served without authentication', async () => {
  for (const path of [
    '/pack/nonexistent/templates/report.hbs',
    '/pack/nonexistent/assets/missing.png',
  ]) {
    const response = await worker.fetch(new URL(path, (await worker.url).href));
    expect(response.status).toBe(404);
  }
});
