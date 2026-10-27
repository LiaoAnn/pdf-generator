import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'import-styles-fonts-local-test';
let worker: PrintWorker;
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
  worker = await startPrintWorker(token, { ASSET_ORIGIN: origin });
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

async function print(
  files: Record<string, string>,
  head = '<link rel="stylesheet" href="../styles/report.css">',
  body = '<p data-gt="text">公司月報</p>',
) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      pack: {
        template: 'templates/report.hbs',
        files: Object.fromEntries(
          Object.entries(files).map(([path, css]) => [
            path,
            Buffer.from(css).toString('base64'),
          ]),
        ),
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

// Each import is relative to styles/report.css, not templates/report.hbs.
// Screen computed styles cannot see these font uses before pagination.
test.each([
  {
    name: 'quoted import with an inherited @page margin font',
    statement: '@import "print/fonts.css";',
    css: '@page { font-family: "Noto Serif TC"; @top-center { content: "頁首月報"; } }',
    font: 'NotoSerifTC-Regular',
    text: '頁首月報',
  },
  {
    name: 'quoted url import with a bold margin-box shorthand',
    statement: '@import url("print/fonts.css");',
    css: '@page { @top-center { content: "頁首月報"; font: bold 16px "Noto Serif TC"; } }',
    font: 'NotoSerifTC-Bold',
    text: '頁首月報',
  },
  {
    name: 'unquoted url import with a print media rule',
    statement: '@import url(print/fonts.css);',
    css: '@media print { body { font-family: "Noto Sans TC"; } }',
    font: 'NotoSansTC-Regular',
    text: '公司月報',
  },
])(
  'linked $name embeds the imported platform face',
  async ({ statement, css, font, text }) => {
    await expectFonts(
      await print({
        'styles/report.css': statement,
        'styles/print/fonts.css': css,
      }),
      [font],
      ['公司月報', text],
    );
    expect(
      cssRequests.some(path => path.endsWith('/styles/print/fonts.css')),
    ).toBe(true);
  },
);

test('nested imports resolve each URL against its own sheet and embed the leaf print font', async () => {
  await expectFonts(
    await print({
      'styles/report.css': '@import "print/middle.css";',
      'styles/print/middle.css': '@import "../faces/leaf.css";',
      'styles/faces/leaf.css':
        '@media print { body { font-family: "Noto Serif TC"; } }',
    }),
    ['NotoSerifTC-Regular'],
    ['公司月報'],
  );
  expect(
    cssRequests.some(path => path.endsWith('/styles/faces/leaf.css')),
  ).toBe(true);
});

test('a head style import resolves against the template and embeds its print-only face', async () => {
  await expectFonts(
    await print(
      {
        'styles/print/fonts.css':
          '@media print { body { font-family: "Noto Serif TC"; } }',
      },
      '<style>@import "../styles/print/fonts.css";</style>',
    ),
    ['NotoSerifTC-Regular'],
    ['公司月報'],
  );
});
