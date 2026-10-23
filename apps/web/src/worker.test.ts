import { expect, test, vi } from 'vitest';
import { createFetchHandler } from './worker.ts';

test('keeps GET /health independent of pages and delegates all other requests unchanged', async () => {
  const env = {} as Env;
  const pages = vi.fn<(request: Request) => Promise<Response>>();
  pages.mockResolvedValue(new Response('TanStack page', { status: 202 }));
  const fetch = createFetchHandler({ pages });

  const health = await fetch(new Request('https://example.com/health'), env);

  expect.soft(health.status).toBe(200);
  expect
    .soft(health.headers.get('content-type'))
    .toMatch(/^application\/json(?:\s*;|$)/i);
  expect.soft(await health.text()).toBe('{"status":"ok","service":"web"}');
  expect.soft(pages).not.toHaveBeenCalled();

  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/other'],
    ['GET', '/health/details'],
    ['GET', '/healthcheck'],
    ['GET', '/health/'],
    ['POST', '/health'],
  ] as const) {
    const request = new Request(new URL(path, 'https://example.com'), {
      method,
    });
    const page = new Response('TanStack response', {
      status: 207,
      headers: { 'x-page-handler': 'preserved' },
    });
    pages.mockClear();
    pages.mockResolvedValue(page);

    const response = await fetch(request, env);

    expect.soft(response, `${method} ${path}`).toBe(page);
    expect.soft(pages, `${method} ${path}`).toHaveBeenCalledTimes(1);
    expect.soft(pages.mock.calls[0]?.[0], `${method} ${path}`).toBe(request);
  }
});
