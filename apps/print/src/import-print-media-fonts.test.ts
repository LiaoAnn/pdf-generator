import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'import-print-media-fonts-local-test';
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
  absentFonts: string[] = [],
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
    for (const font of absentFonts) expect(embedded).not.toContain(font);
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

// A print media list applies to the entire imported sheet, even plain rules.
test('a print-media import embeds regular and bold faces from plain rules', async () => {
  await expectFonts(
    await print(
      {
        'styles/report.css': '@import "print/fonts.css" print;',
        'styles/print/fonts.css':
          'body { font-family: "Noto Serif TC"; } strong { font-weight: 700; }',
      },
      undefined,
      '<p data-gt="text">公司月報</p><strong data-gt="text">財務摘要</strong>',
    ),
    ['NotoSerifTC-Regular', 'NotoSerifTC-Bold'],
    ['公司月報', '財務摘要'],
  );
});

// A screen-applied face may be declared during the initial screen scan;
// PDF embedding, rather than declaration or request count, tests print use.
test('a screen-only import does not embed its face in the printed PDF', async () => {
  await expectFonts(
    await print(
      {
        'styles/report.css':
          '@import "../styles/screen.css" screen; body { font-size: 16px; line-height: 24px; } p, div { height: 24px; margin: 0; } @media print { body { font-family: "Noto Sans TC"; } }',
        'styles/screen.css': 'p { font-family: "Noto Serif TC"; }',
      },
      undefined,
      '<p data-gt="text">公司月報</p><div data-gt="text">財務摘要</div>',
    ),
    ['NotoSansTC-Regular'],
    ['公司月報'],
    ['NotoSerifTC-Regular'],
  );
});
