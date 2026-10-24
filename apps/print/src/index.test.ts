import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker();
  await worker.url;
}, 30_000);

afterAll(async () => {
  await worker?.dispose();
});

test.each([
  'NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf',
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
  'LXGWWenKaiTC-Regular.ttf',
  'NotoSansSymbols2-Regular.ttf',
])(
  'serves committed font %s unchanged with a reusable browser cache',
  async name => {
    // Read large assets over HTTP to avoid the "Body has already been read"
    // failure observed with worker.fetch under full-suite load.
    const response = await fetch(
      new URL(`/fonts/${name}`, (await worker.url).href),
    );
    expect(response.status).toBe(200);
    const cache = response.headers.get('cache-control') ?? '';
    expect(cache).toMatch(/max-age=\d+/i);
    expect(Number(/max-age=(\d+)/i.exec(cache)?.[1])).toBeGreaterThanOrEqual(
      86_400,
    );
    const committed = await readFile(
      new URL(`../public/fonts/${name}`, import.meta.url),
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(committed)).toBe(
      true,
    );
  },
);

test.each(['LICENSE-noto-cjk.txt', 'LICENSE-lxgw.txt', 'LICENSE-symbols2.txt'])(
  'makes bundled font licence %s available to asset consumers',
  async name => {
    const response = await worker.fetch(
      new URL(`/fonts/${name}`, (await worker.url).href),
    );
    expect(response.status).toBe(200);
    const licence = await response.text();
    expect(licence).toBe(
      await readFile(
        new URL(`../public/fonts/${name}`, import.meta.url),
        'utf8',
      ),
    );
    expect(licence).toMatch(/SIL OPEN FONT LICENSE/i);
  },
);

test('serves the Paged.js 0.4.3 polyfill as JavaScript rather than the Worker fallback', async () => {
  const response = await worker.fetch(
    new URL('/paged.polyfill.js', (await worker.url).href),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(
    /(?:javascript|ecmascript)/i,
  );
  const script = await response.text();
  expect(script).toBe(
    await readFile(
      new URL('../public/paged.polyfill.js', import.meta.url),
      'utf8',
    ),
  );
  expect(script).toMatch(/Paged\.js v0\.4\.3/);
});
