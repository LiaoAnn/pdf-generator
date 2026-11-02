// Prints of one batch in one browser session share a browser context, so
// the browser keeps the pack's files between them: each file Chrome can
// cache there (up to 6.25 MiB in such a context, Chrome 126) loads once per
// session, a larger one once per print. Nothing else may carry over: every
// print is byte-identical to the same fixture printed alone.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';
import { readValidPack, type ValidPack } from './valid-pack.fixture.ts';

const token = 'batch-pack-cache-local-test';
const batch = '9c2e4f60-3a1b-4c5d-8e7f-0a1b2c3d4e01';
const mib = 1024 * 1024;
let worker: PrintWorker;
let server: Server;
let origin: string;
let pack: ValidPack;
let files: Record<string, string>;
let digest: string;
// GET requests the print browser sent, by path (query included).
const requests: string[] = [];

/** A valid 1×1 PNG padded to `bytes` with a private ancillary chunk. */
function paddedPng(bytes: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
  ];
  const end = chunk('IEND', Buffer.alloc(0));
  const used = parts.reduce((sum, part) => sum + part.length, end.length);
  // A chunk adds 12 bytes around its data.
  parts.push(chunk('ppAd', Buffer.alloc(bytes - used - 12, 0x2e)));
  return Buffer.concat([...parts, end]);
}

beforeAll(async () => {
  pack = await readValidPack();
  files = {
    ...pack.files,
    'assets/under.png': paddedPng(6 * mib).toString('base64'),
    'assets/over.png': paddedPng(6.5 * mib).toString('base64'),
  };
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
        // The Worker names its own origin; the browser sees this one.
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
      body: JSON.stringify({ files }),
    },
  );
  expect(uploaded.status).toBe(200);
  digest = ((await uploaded.json()) as { digest: string }).digest;
});

beforeEach(() => {
  requests.length = 0;
});

afterAll(async () => {
  await worker?.dispose();
  await new Promise<void>(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

const images =
  '<img data-gt="image" src="../assets/under.png" alt="" style="width:4px">' +
  '<img data-gt="image" src="../assets/over.png" alt="" style="width:4px">';

/**
 * Fixture `n` of the batch: the template with its own data. Fixture 2 also
 * tries to leave state behind (a script, storage, a cookie, a font face
 * named Leak); fixture 3 asks for that face without declaring it, so a face
 * that carried over would print its text in the pack font instead of Noto.
 */
function fixture(n: number): string {
  let html = pack
    .html({ company: `第${n}號測試有限公司`, contact: `聯絡人${n}` })
    .replace('</body>', `${images}</body>`);
  if (n === 2) {
    html = html
      .replace(
        '</head>',
        '<style>@font-face { font-family: Leak; src: url("../assets/report.woff2"); }</style>' +
          '<script>localStorage.setItem("k", "leak"); document.cookie = "k=leak; path=/";</script></head>',
      )
      .replace(
        '</body>',
        '<p data-gt="text" style="font-family: Leak">月報</p></body>',
      );
  }
  if (n === 3) {
    html = html.replace(
      '</body>',
      '<p data-gt="text" style="font-family: Leak, &quot;Noto Sans TC&quot;">月報</p></body>',
    );
  }
  return html;
}

async function print(
  html: string,
  { session, inline = false }: { session?: string; inline?: boolean } = {},
) {
  const response = await worker.fetch(
    new URL('/print', (await worker.url).origin),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(session ? { 'x-browser-session': session } : {}),
      },
      body: JSON.stringify({
        html,
        page: pack.page,
        pack: inline
          ? { template: pack.template, files }
          : { template: pack.template, batch, digest },
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const pdf = new Uint8Array(await response.arrayBuffer());
  return {
    sha: createHash('sha256').update(pdf).digest('hex'),
    pdf,
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
  requests.filter(
    url => url.split('?')[0] === `/batch/${batch}/${digest}/${path}`,
  ).length;

// Regression: a per-print context (or the cache left off) makes every print
// of a batch load every pack file again; counting the large file pins where
// Chrome's limit lies, so a change in it shows here instead of in a batch.
test('in one session, each pack file up to 6.25 MiB loads once over 10 prints; a larger one loads every print', async () => {
  let session = 'new';
  const sessions = new Set<string | undefined>();
  try {
    for (let n = 1; n <= 10; n++) {
      const printed = await print(fixture(n), { session });
      sessions.add(printed.session);
      session = printed.session ?? 'new';
    }
  } finally {
    await closeSession(session === 'new' ? undefined : session);
  }
  expect([...sessions]).toEqual([session]);
  expect({
    font: loads('assets/report.woff2'),
    css: loads('styles/report.css'),
    logo: loads('assets/logo.svg'),
    under: loads('assets/under.png'),
    documents: loads(pack.template),
  }).toEqual({ font: 1, css: 1, logo: 1, under: 1, documents: 10 });
  // Over the limit: loaded again by every print (twice per print without
  // the cache, measured before this change), never kept between prints.
  expect(loads('assets/over.png')).toBeGreaterThanOrEqual(10);
});

const text = async (pdf: Uint8Array) =>
  (await extractText(await getDocumentProxy(pdf), { mergePages: false })).text;

// Regression: a reused context that keeps a page's state (its fonts, storage,
// cookies, scripts' effects) or a cache whose contents change the PDF makes
// a fixture's bytes depend on what the session printed before. Prints by
// reference have the cache on also when they run alone, because the cache
// itself changes one document shape: two @font-face rules on one font file
// (fixture 2) embed one font subset with it, two without (Chrome 126, same
// text and glyphs). Every other fixture still prints exactly what the inline
// (uncached) form prints.
test('each print in a reused context is byte-identical to the same fixture printed alone, in either order', async () => {
  const fixtures = [1, 2, 3, 4];
  const alone = new Map<number, string>();
  for (const n of fixtures) {
    const printed = await print(fixture(n));
    alone.set(n, printed.sha);
    const inline = await print(fixture(n), { inline: true });
    if (n === 2) {
      expect(await text(inline.pdf), 'inline 2 text').toEqual(
        await text(printed.pdf),
      );
    } else {
      expect(inline.sha, `inline ${n}`).toBe(printed.sha);
    }
  }
  expect(new Set(alone.values()).size).toBe(fixtures.length);

  for (const order of [fixtures, [...fixtures].reverse()]) {
    let session = 'new';
    try {
      for (const n of order) {
        const printed = await print(fixture(n), { session });
        session = printed.session ?? 'new';
        expect(printed.sha, `fixture ${n} in order ${order.join('→')}`).toBe(
          alone.get(n),
        );
      }
    } finally {
      await closeSession(session === 'new' ? undefined : session);
    }
  }
  // 16 prints and two text extractions: about two minutes on the shared VM.
}, 300_000);
