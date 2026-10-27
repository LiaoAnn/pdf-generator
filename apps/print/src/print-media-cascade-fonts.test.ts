import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gtSchema } from '@pdf-generator/contract';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'print-media-cascade-fonts-local-test';
let worker: PrintWorker;
let server: Server;
let origin: string;
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
  inspect = false,
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
      ...(inspect
        ? {
            source: {
              templateId: 'cascade-layout',
              templateVersion: 1,
              seed: 'same',
              index: 0,
            },
          }
        : {}),
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

// A declaration-by-declaration scan sees the regular family but cannot
// combine it with the heading's inherited family and separate bold weight.
const cascade = `@media print { html { font-family: "Noto Serif TC"; } }
  h1 { font-weight: bold; font-size: 20px; }
  p { font-weight: normal; }`;

test.each(['linked', 'imported'] as const)(
  '%s print-only family inherited by a bold heading embeds the real bold face',
  async kind => {
    const files: Record<string, string> =
      kind === 'linked'
        ? { 'styles/report.css': cascade }
        : {
            'styles/report.css': '@import "print/fonts.css";',
            'styles/print/fonts.css': cascade,
          };
    await expectFonts(
      await print(
        files,
        undefined,
        '<h1 data-gt="heading">財務摘要</h1><p data-gt="paragraph">公司月報</p>',
      ),
      ['NotoSerifTC-Regular', 'NotoSerifTC-Bold'],
      ['財務摘要', '公司月報'],
    );
    if (kind === 'imported') {
      expect(
        cssRequests.some(path => path.endsWith('/styles/print/fonts.css')),
      ).toBe(true);
    }
  },
);

// Paged.js paginates on screen. This retained sheet must shrink blocks only
// when printing; leaving its media forced to all changes the pagination.
test('font selection restores print media before pagination and preserves ground-truth boxes', async () => {
  const response = await print(
    {
      'styles/report.css': `@page { size: A4; margin: 20mm; }
      body { margin: 0; } .probe { width: 100px; height: 400px; background: black; break-inside: avoid; }`,
    },
    `<link rel="stylesheet" href="../styles/report.css">
      <style data-pagedjs-ignore>@media print {
        html { font-family: "Noto Serif TC"; }
        body div.probe { height: 100px; }
      }</style>`,
    Array.from(
      { length: 4 },
      () => '<div class="probe" data-gt="image"></div>',
    ).join(''),
    true,
  );
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const result = (await response.json()) as {
    pageCount: number;
    pdf: string;
    gt: unknown;
  };
  const gt = gtSchema.parse(result.gt);
  // Baseline from the runtime before cascade-aware font selection: screen
  // pagination puts two 400px blocks per page; print shrinks each to 100px.
  expect(
    gt.blocks.map(({ page, bbox, order }) => ({ page, bbox, order })),
  ).toEqual([
    { page: 1, bbox: [56.68, 56.68, 131.68, 131.68], order: 0 },
    { page: 1, bbox: [56.68, 131.68, 131.68, 206.68], order: 1 },
    { page: 2, bbox: [56.68, 56.68, 131.68, 131.68], order: 2 },
    { page: 2, bbox: [56.68, 131.68, 131.68, 206.68], order: 3 },
  ]);
  expect(result.pageCount).toBe(2);
  expect(gt.pages).toEqual([
    { width: 595.28, height: 841.89 },
    { width: 595.28, height: 841.89 },
  ]);
  const pdf = await getDocumentProxy(
    new Uint8Array(Buffer.from(result.pdf, 'base64')),
  );
  try {
    expect(pdf.numPages).toBe(2);
  } finally {
    await pdf.loadingTask.destroy();
  }
});
