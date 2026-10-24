import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { apiErrorSchema } from '@pdf-generator/contract';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';

const token = 'linked-styles-fonts-local-test';
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let server: Server;
let origin: string;
let failedFont: string | undefined;
const fontRequests: string[] = [];
const cssRequests: string[] = [];

beforeAll(async () => {
  // Only transport is controlled: the real Worker still publishes and serves
  // every pack file, and real Chrome runs the unmodified print runtime.
  server = createServer(async (request, response) => {
    try {
      const path = request.url ?? '/';
      if (path.endsWith('.css')) {
        cssRequests.push(path);
        // DOMContentLoaded does not wait for linked CSS. Delay its response
        // rather than depending on machine load to expose the selection race.
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (path.startsWith('/fonts/')) {
        fontRequests.push(path);
        if (path === failedFont) {
          response.writeHead(404);
          response.end('deliberately missing platform face');
          return;
        }
      }
      const upstreamOrigin = (await worker.url).origin;
      const upstream = await fetch(new URL(path, upstreamOrigin));
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? '',
        ...(upstream.headers.has('content-security-policy')
          ? {
              // Translate only the proxy origin, retaining the production
              // allowlist of runtime/Paged scripts and all other directives.
              'content-security-policy': (
                upstream.headers.get('content-security-policy') ?? ''
              ).replaceAll(upstreamOrigin, origin),
            }
          : {}),
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    bindings: {
      PRINT_TOKEN: { type: 'plain_text', value: token },
      ASSET_ORIGIN: { type: 'plain_text', value: origin },
    },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false },
  });
  await worker.url;
});

beforeEach(() => {
  failedFont = undefined;
  fontRequests.length = 0;
  cssRequests.length = 0;
});

afterAll(async () => {
  await worker?.dispose();
  await new Promise<void>(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

async function print(css: string, body = '<p data-gt="text">公司月報</p>') {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><link rel="stylesheet" href="../styles/report.css"></head><body>${body}</body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      pack: {
        template: 'templates/report.hbs',
        files: { 'styles/report.css': Buffer.from(css).toString('base64') },
      },
    }),
  });
}

async function expectFonts(
  response: Response,
  fonts: string[],
  text: string[],
) {
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  const pdf = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    const raw = Buffer.from(await pdf.getData()).toString('latin1');
    const embedded = [...raw.matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g)].map(
      match => (match[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
    );
    for (const font of fonts) expect(embedded).toContain(font);
    expect(raw).toMatch(/\/FontFile[23]?\b/);
    const extracted = (
      await extractText(pdf, { mergePages: true })
    ).text.replace(/\s/gu, '');
    for (const expected of text) expect(extracted).toContain(expected);
  } finally {
    await pdf.loadingTask.destroy();
  }
  expect(cssRequests.length).toBeGreaterThan(0);
}

// Slice 1: selecting faces before linked CSS arrives loses regular and bold
// faces alike, while still returning a successful PDF containing fallback text.
test('delayed linked body and bold rules embed both platform faces', async () => {
  await expectFonts(
    await print(
      'body { font-family: "Noto Serif TC"; } strong { font-weight: 700; }',
      '<p data-gt="text">公司月報</p><strong data-gt="text">財務摘要</strong>',
    ),
    ['NotoSerifTC-Regular', 'NotoSerifTC-Bold'],
    ['公司月報', '財務摘要'],
  );
});

// Slice 1: an undeclared platform face cannot fail loading, so the old race
// silently bypasses font_not_loaded as well as embedding the wrong font.
test('a missing platform face used only by delayed linked CSS returns font_not_loaded', async () => {
  failedFont = '/fonts/NotoSerifTC-Regular.otf';
  const response = await print('body { font-family: "Noto Serif TC"; }');
  expect(response.status).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('font_not_loaded');
  expect(JSON.stringify(error.details)).toContain('Noto Serif TC');
  expect(fontRequests).toContain(failedFont);
});

// Slice 2: computed screen styles cannot reveal generated margin text or
// print-only families; waiting for links alone does not fix these regressions.
test.each([
  {
    name: '@page inherited margin font',
    css: '@page { font-family: "Noto Serif TC"; @top-center { content: "頁首月報"; } }',
    font: 'NotoSerifTC-Regular',
    text: '頁首月報',
  },
  {
    name: '@page margin-box bold shorthand',
    css: '@page { @top-center { content: "頁首月報"; font: bold 16px "Noto Serif TC"; } }',
    font: 'NotoSerifTC-Bold',
    text: '頁首月報',
  },
  {
    name: '@media print override',
    css: '@media print { body { font-family: "Noto Sans TC"; } }',
    font: 'NotoSansTC-Regular',
    text: '公司月報',
  },
])('linked $name embeds its platform face', async ({ css, font, text }) => {
  await expectFonts(await print(css), [font], [text]);
});
