// Chrome's in-memory cache in a batch's shared browser context keeps no
// response over 6.25 MiB (Chrome 126), so the platform fonts above that are
// served as unicode-range chunks under 6 MiB (T07-37): the prints of one
// session load each chunk once, and every character still prints in its
// platform font.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'platform-font-chunks-local-test';
const batch = '5d0c7e21-8b4a-4f3e-9c2d-1a2b3c4d5e37';
let worker: PrintWorker;
let server: Server;
let origin: string;
let digest: string;
// GET requests the print browser sent, by path (query included).
const requests: string[] = [];

beforeAll(async () => {
  // Only transport is observed: the real Worker serves every file, with its
  // own headers, to the real local Chrome.
  server = createServer(async (request, response) => {
    try {
      const path = request.url ?? '/';
      if (request.method === 'GET') requests.push(path);
      const upstreamOrigin = (await worker.url).origin;
      const upstream = await fetch(new URL(path, upstreamOrigin), {
        method: request.method ?? 'GET',
      });
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (['content-encoding', 'content-length'].includes(name)) return;
        headers[name] = value.replaceAll(upstreamOrigin, origin);
      });
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = await startPrintWorker(token, { ASSET_ORIGIN: origin });
  const uploaded = await worker.fetch(
    new URL(`/batch/${batch}/pack`, (await worker.url).origin),
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          'template.hbs': Buffer.from(
            '<!doctype html><html><head></head><body></body></html>',
          ).toString('base64'),
        },
      }),
    },
  );
  expect(uploaded.status).toBe(200);
  digest = ((await uploaded.json()) as { digest: string }).digest;
});

afterAll(async () => {
  await worker?.dispose();
  await new Promise<void>(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

// A character of every chunk: Latin and fullwidth punctuation (part0),
// 一 份 (part1, below U+6A00), 樣 第 (part2, U+6A00–87FF), 體 (part3).
const text = (n: number) => `A，一樣體第${n}份`;

/** Fixture `n`: the same text in each split face. */
const fixture = (n: number) =>
  '<!doctype html><html><head><style>' +
  '.serif { font-family: "Noto Serif TC"; }' +
  '.bold { font-family: "Noto Serif TC"; font-weight: 700; }' +
  '.kai { font-family: "LXGW WenKai TC"; }' +
  '</style></head><body>' +
  `<p data-gt="text" class="serif">${text(n)}</p>` +
  `<p data-gt="text" class="bold">${text(n)}</p>` +
  `<p data-gt="text" class="kai">${text(n)}</p>` +
  '</body></html>';

async function print(html: string, session: string) {
  const response = await worker.fetch(
    new URL('/print', (await worker.url).origin),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-browser-session': session,
      },
      body: JSON.stringify({
        html,
        page: { size: 'A4', orientation: 'portrait' },
        pack: { template: 'template.hbs', batch, digest },
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return {
    pdf: new Uint8Array(await response.arrayBuffer()),
    session: response.headers.get('x-browser-session') ?? undefined,
  };
}

async function closeSession(id: string | undefined) {
  if (!id) return;
  await worker.fetch(new URL(`/session/${id}`, (await worker.url).origin), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}

const loads = (path: string) =>
  requests.filter(url => url.split('?')[0] === path).length;

/** Embedded font names without their subset tag. */
const embeddedFonts = (pdf: Uint8Array) =>
  [
    ...new Set(
      [
        ...Buffer.from(pdf)
          .toString('latin1')
          .matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g),
      ].map(match => (match[1] ?? '').replace(/^[A-Z]{6}\+/, '')),
    ),
  ].sort();

// Regression: a whole font over the cache limit (or the runtime still asking
// for one) is downloaded by every print of a batch; a chunk declared with
// another chunk's unicode-range prints its characters in a fallback font.
test('in one session, each chunk of a split platform font loads once over 10 prints, and every character prints in its platform font', async () => {
  let session = 'new';
  const sessions = new Set<string | undefined>();
  let first: Uint8Array | undefined;
  try {
    for (let n = 1; n <= 10; n++) {
      const printed = await print(fixture(n), session);
      first ??= printed.pdf;
      sessions.add(printed.session);
      session = printed.session ?? 'new';
    }
  } finally {
    await closeSession(session === 'new' ? undefined : session);
  }
  expect([...sessions]).toEqual([session]);

  const chunks = [0, 1, 2, 3].flatMap(part => [
    `/fonts/NotoSerifTC-Regular.part${part}.otf`,
    `/fonts/NotoSerifTC-Bold.part${part}.otf`,
    `/fonts/LXGWWenKaiTC-Regular.part${part}.ttf`,
  ]);
  expect(Object.fromEntries(chunks.map(path => [path, loads(path)]))).toEqual(
    Object.fromEntries(chunks.map(path => [path, 1])),
  );
  expect({
    serif: loads('/fonts/NotoSerifTC-Regular.otf'),
    bold: loads('/fonts/NotoSerifTC-Bold.otf'),
    kai: loads('/fonts/LXGWWenKaiTC-Regular.ttf'),
  }).toEqual({ serif: 0, bold: 0, kai: 0 });

  const pdf = first ?? new Uint8Array();
  expect(embeddedFonts(pdf)).toEqual([
    'LXGWWenKaiTC-Regular',
    'NotoSerifTC-Bold',
    'NotoSerifTC-Regular',
  ]);
  const { text: printed } = await extractText(
    await getDocumentProxy(pdf.slice()),
    { mergePages: true },
  );
  expect(printed.replace(/\s/gu, '')).toBe(text(1).repeat(3));
});
