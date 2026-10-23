import { expect, test } from 'vitest';
import worker from './index.ts';

test('GET /health returns web health JSON while other paths keep the placeholder', async () => {
  const env = {} as Env;
  const ctx = {} as ExecutionContext;
  const health = await worker.fetch(
    new Request('http://example.com/health'),
    env,
    ctx,
  );

  expect.soft(health.status).toBe(200);
  expect
    .soft(health.headers.get('content-type'))
    .toMatch(/^application\/json(?:\s*;|$)/i);
  expect.soft(await health.text()).toBe('{"status":"ok","service":"web"}');

  for (const path of ['/', '/other', '/health/details', '/healthcheck']) {
    const response = await worker.fetch(
      new Request(new URL(path, 'http://example.com')),
      env,
      ctx,
    );

    expect.soft(response.status, path).toBe(200);
    expect
      .soft(await response.text(), path)
      .toBe('pdf-generator web: placeholder');
  }
});
