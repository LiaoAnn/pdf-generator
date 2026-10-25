import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'request-blocking-priority-local-test';
const hits: string[] = [];
let connections = 0;
let server: Server;
let outside: string;
let logo: string;
let worker: PrintWorker;

beforeAll(async () => {
  logo = (
    await readFile(
      new URL(
        '../../../packages/template-tools/fixtures/valid/assets/logo.svg',
        import.meta.url,
      ),
    )
  ).toString('base64');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQMgkDAAD4AJ3MaiF4AAAAAElFTkSuQmCC',
    'base64',
  );
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, {
      'content-type': 'image/png',
      'access-control-allow-origin': '*',
    });
    res.end(png);
  });
  server.on('connection', () => {
    connections += 1;
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
  server.closeAllConnections();
  hits.length = 0;
  connections = 0;
});

// Zero hits/connections is meaningful only if the observer sees real traffic.
test('the outside observer records both HTTP requests and TCP connections', async () => {
  const response = await fetch(`${outside}/control.png`);
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(hits).toEqual(['/control.png']);
  expect(connections).toBeGreaterThan(0);
});

// Regression: the SVG request and print-ready state race, allowing css_animation
// to mask request_blocked. At the observed loaded rate (23/150), 32 renders
// catch the pre-fix race with ~99.5% probability while keeping renders under a
// minute. Separate cases finish every attempt and report the failure count.
test.each(Array.from({ length: 32 }, (_, index) => index + 1))(
  'request_blocked wins over SVG <set> css_animation with zero outside traffic (render %i/32)',
  async () => {
    const blocked = `${outside}/animated.png`;
    const response = await worker.fetch(
      new URL('/print', (await worker.url).href),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          html: `<!doctype html><html><head><meta charset="utf-8"><style>div { width:32px; height:32px }</style></head><body><p data-gt="text">PACK TEXT</p><svg width="32" height="32"><image href="../assets/logo.svg" width="32" height="32"><set attributeName="href" to="${blocked}" begin="0s"/></image></svg></body></html>`,
          page: { size: 'A4', orientation: 'portrait' },
          pack: {
            template: 'templates/report.hbs',
            files: { 'assets/logo.svg': logo },
          },
        }),
      },
    );
    expect.soft(response.status).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect.soft(error.code).toBe('request_blocked');
    expect.soft(JSON.stringify(error.details)).toContain(blocked);
    expect.soft(hits).toEqual([]);
    expect.soft(connections).toBe(0);
  },
);
