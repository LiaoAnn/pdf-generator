import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gtSchema } from '@pdf-generator/contract';
import { extractText, getDocumentProxy } from 'unpdf';
import { expect } from 'vitest';
import { startPrintWorker } from './test-worker.ts';

// Observe the public FontFaceSet and CSSOM without replacing selection or
// pagination. The proxy appends observation hooks to the real Worker's runtime.
const observe = (consumedSheets: boolean) => `
(() => {
  const report = value => new Promise(resolve => {
    const image = new Image();
    image.onload = image.onerror = resolve;
    image.src = '/fonts/test-observation?value=' + encodeURIComponent(JSON.stringify(value));
  });
  const media = () => [...document.querySelectorAll('[data-media-probe]')].map(node => {
    const sheet = node.sheet;
    return { sheet: sheet.media.mediaText, rules: [...sheet.cssRules]
      .filter(rule => rule.media).map(rule => rule.media.mediaText) };
  });
  const before = window.PagedConfig.before;
  let owned = [];
  const ownedMedia = () => owned.map(({ node, sheet }) => ({
    attribute: node.getAttribute('media'), sheet: sheet.media.mediaText,
    rules: [...sheet.cssRules].filter(rule => rule.media).map(rule => rule.media.mediaText)
  }));
  window.PagedConfig.before = async (...args) => {
    await before(...args);
    if (${consumedSheets}) owned = [...document.querySelectorAll('[data-media-probe]')]
      .map(node => ({ node, sheet: node.sheet }));
    await report({
      phase: 'before', media: media(),
      ...(${consumedSheets} ? { ownedMedia: ownedMedia() } : {}),
      faces: [...document.fonts].map(face => face.family + '|' + face.weight)
    });
  };
  window.__pdfgen.ready.then(() => report({ phase: 'ready', media: media(),
    ...(${consumedSheets} ? { ownedMedia: ownedMedia() } : {}) }));
  if (${consumedSheets}) {
    const printed = window.__pdfgen.printed;
    window.__pdfgen.printed = async (...args) => {
      const result = await printed(...args);
      await report({ phase: 'printed', styles: [...document.querySelectorAll('.pagedjs_page [data-font-probe]')]
        .map(node => { const style = getComputedStyle(node);
          return { family: style.fontFamily, weight: style.fontWeight }; }) });
      return result;
    };
  }
})();`;

export async function fontFixture(consumedSheets = false) {
  const token = 'screen-media-fonts-test';
  const observations: {
    phase: string;
    media: { sheet: string; rules: string[] }[];
    faces?: string[];
    ownedMedia?: { attribute: string | null; sheet: string; rules: string[] }[];
    styles?: { family: string; weight: string }[];
  }[] = [];
  let worker: Awaited<ReturnType<typeof startPrintWorker>>;
  let origin: string;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url ?? '/';
      if (path.startsWith('/fonts/test-observation?')) {
        observations.push(
          JSON.parse(
            new URL(path, 'http://test').searchParams.get('value') ?? '{}',
          ),
        );
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
            'base64',
          ),
        );
        return;
      }
      const upstreamOrigin = (await worker.url).origin;
      const upstream = await fetch(new URL(path, upstreamOrigin));
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? '',
        ...(upstream.headers.has('content-security-policy')
          ? {
              'content-security-policy': (
                upstream.headers.get('content-security-policy') ?? ''
              ).replaceAll(upstreamOrigin, origin),
            }
          : {}),
      });
      if (path === '/print-runtime.js') {
        // Mutation runs may serve a broken copy from container /tmp; never
        // write production code in the worktree.
        const runtime = process.env.SCREEN_MEDIA_RUNTIME_COPY
          ? await readFile(process.env.SCREEN_MEDIA_RUNTIME_COPY, 'utf8')
          : await upstream.text();
        response.end(runtime + observe(consumedSheets));
      } else response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = await startPrintWorker(token, { ASSET_ORIGIN: origin });
  await worker.url;
  return {
    observations,
    async dispose() {
      await worker.dispose();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    async print(
      head: string,
      files: Record<string, string> = {},
      body = '<h1 data-gt="heading">財務摘要</h1><p data-gt="paragraph">公司月報</p>',
    ) {
      observations.length = 0;
      const response = await fetch(new URL('/print', await worker.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          html: `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
          page: { size: 'A4', orientation: 'portrait' },
          source: {
            templateId: 'screen-media',
            templateVersion: 1,
            seed: 'same',
            index: 0,
          },
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
      expect(
        response.status,
        response.status === 200 ? '' : await response.text(),
      ).toBe(200);
      const result = (await response.json()) as {
        pdf: string;
        gt: unknown;
        pageCount: number;
      };
      const pdf = await getDocumentProxy(
        new Uint8Array(Buffer.from(result.pdf, 'base64')),
      );
      try {
        const raw = Buffer.from(await pdf.getData()).toString('latin1');
        const fonts = [...raw.matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g)].map(
          match => (match[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
        );
        const text = (
          await extractText(pdf, { mergePages: true })
        ).text.replace(/\s/gu, '');
        return {
          fonts,
          text,
          gt: gtSchema.parse(result.gt),
          pageCount: result.pageCount,
        };
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  };
}

export const cascade = `@page { size: A4; margin: 20mm; }
  @media print { html { font-family: "Noto Serif TC"; } }
  body { font-size: 16px; line-height: 24px; }
  h1 { font-weight: bold; font-size: 20px; height: 28px; line-height: 28px; }
  p { font-weight: normal; height: 24px; }`;

export const probes = Array.from(
  { length: 4 },
  () => '<div class="probe" data-gt="image"></div>',
).join('');
export const geometry =
  '@page { size: A4; margin: 20mm; } body { margin: 0; } .probe { width: 100px; height: 400px; break-inside: avoid; background: black; }';
