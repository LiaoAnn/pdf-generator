import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'request-blocking-local-test';
const page = { size: 'A4', orientation: 'portrait' } as const;
const encode = (value: string | Uint8Array) =>
  Buffer.from(value).toString('base64');
// A genuine 1x1 PNG, so a request that is let through gets a usable image.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQMgkDAAD4AJ3MaiF4AAAAAElFTkSuQmCC',
  'base64',
);

let worker: PrintWorker;
let server: Server;
let outside: string;
let logo: Buffer;
let font: Buffer;
// Every request the "outside" server receives: path and query.
const hits: string[] = [];

beforeAll(async () => {
  logo = await readFile(
    new URL(
      '../../../packages/template-tools/fixtures/valid/assets/logo.svg',
      import.meta.url,
    ),
  );
  font = await readFile(
    new URL('./test-fixtures/pack-font/report.woff2', import.meta.url),
  );
  // Answers every path with something the browser accepts, so a request that
  // is not blocked would succeed and the print would carry on.
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const path = req.url ?? '';
    const [type, body] = path.endsWith('.css')
      ? ['text/css', 'p { color: #000 }']
      : path.endsWith('.woff2')
        ? ['font/woff2', font]
        : ['image/png', png];
    res.writeHead(200, {
      'content-type': type,
      'access-control-allow-origin': '*',
    });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  outside = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
  await new Promise<void>(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

beforeEach(() => {
  hits.length = 0;
});

async function post(body: unknown) {
  return worker.fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const document = (body: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><style>div { width:32px; height:32px }</style>${head}</head><body><p data-gt="text">PACK TEXT</p>${body}</body></html>`;

// Without this, "the outside server received 0 requests" would also pass when
// the server cannot be reached from where the checks run.
test('the outside server records a request that is made to it', async () => {
  const response = await fetch(`${outside}/control.png`);
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(hits).toEqual(['/control.png']);
});

const unusedUuid = '11111111-2222-4333-8444-555555555555';
// `blocked` is what the 422 details must name: a full URL, or the tail of a
// URL on the print Worker's own origin (its print id is random).
const cases: [
  string,
  (outside: string) => { body: string; head?: string; blocked: string },
][] = [
  [
    '<link rel=stylesheet href=http://…>',
    o => ({
      head: `<link rel="stylesheet" href="${o}/linked.css">`,
      body: '',
      blocked: `${o}/linked.css`,
    }),
  ],
  [
    '<img src=http://…>',
    o => ({
      body: `<img width="32" height="32" src="${o}/image.png">`,
      blocked: `${o}/image.png`,
    }),
  ],
  [
    'CSS background url(http://…)',
    o => ({
      head: `<style>.picture { background:url("${o}/background.png") no-repeat; background-size:32px 32px }</style>`,
      body: '<div class="picture"></div>',
      blocked: `${o}/background.png`,
    }),
  ],
  [
    '@font-face src url(http://…)',
    o => ({
      head: `<style>@font-face { font-family:"Remote Face"; src:url("${o}/face.woff2") format("woff2") } p { font-family:"Remote Face" }</style>`,
      body: '',
      blocked: `${o}/face.woff2`,
    }),
  ],
  [
    'a data: stylesheet that @imports the server',
    o => ({
      head: `<link rel="stylesheet" href="data:text/css,${encodeURIComponent(`@import url("${o}/imported.css");`)}">`,
      body: '',
      blocked: `${o}/imported.css`,
    }),
  ],
  [
    'a data: stylesheet whose url() loads from the server',
    o => ({
      head: `<link rel="stylesheet" href="data:text/css,${encodeURIComponent(`.picture { background:url("${o}/from-data.png") no-repeat; background-size:32px 32px }`)}">`,
      body: '<div class="picture"></div>',
      blocked: `${o}/from-data.png`,
    }),
  ],
  [
    'an SVG <set> that changes an <image> href to the server',
    o => ({
      body: `<svg width="32" height="32"><image href="../assets/logo.svg" width="32" height="32"><set attributeName="href" to="${o}/animated.png" begin="0s"/></image></svg>`,
      blocked: `${o}/animated.png`,
    }),
  ],
  [
    'a pack-relative URL to a path that is not in pack.files',
    () => ({
      body: '<img width="32" height="32" src="../assets/not-sent.png">',
      blocked: '/assets/not-sent.png',
    }),
  ],
  [
    "another print id's /pack/ path",
    () => ({
      body: `<img width="32" height="32" src="/pack/${unusedUuid}/assets/logo.svg">`,
      blocked: `/pack/${unusedUuid}/assets/logo.svg`,
    }),
  ],
  [
    "the print Worker's own /print route",
    () => ({
      body: '<img width="32" height="32" src="/print">',
      blocked: '/print',
    }),
  ],
];

// Regression: each of these lets a fixture depend on something other than its
// template pack and data (a remote font, image or stylesheet), and the ground
// truth would then describe content that was not drawn from the pack.
test.each(cases)(
  'a document that loads %s fails with request_blocked and the outside server gets no request',
  async (_name, build) => {
    const { body, head, blocked } = build(outside);
    const response = await post({
      html: document(body, head),
      page,
      pack: {
        template: 'templates/report.hbs',
        files: { 'assets/logo.svg': encode(logo) },
      },
    });
    expect(response.status).toBe(422);
    const parsed = apiErrorSchema.parse(await response.json()).error;
    expect(parsed.code).toBe('request_blocked');
    expect(JSON.stringify(parsed.details)).toContain(blocked);
    expect(hits).toEqual([]);
  },
);
