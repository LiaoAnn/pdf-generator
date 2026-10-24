import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  type BatchRequest,
  batchListSchema,
  batchSchema,
  fixtureListSchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { storeFixturePack } from '../templates/fixture-pack.ts';
import { createFetchHandler } from '../worker.ts';

const configPath = fileURLToPath(
  new URL('../../wrangler.jsonc', import.meta.url),
);
const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);
type LocalPlatform = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let platform: LocalPlatform;
const local = createLocalAccess();
const fetch = createFetchHandler({
  pages: async () =>
    new Response('API unexpectedly reached pages', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
const input: BatchRequest = {
  templateId: 'fixture-report',
  templateVersion: 1,
  count: 3,
  seed: 'T16_reproducible-1',
};
const fakeWorkflow = {
  create: vi.fn(
    async ({ id }: { id: string; params: { batchId: string } }) => ({ id }),
  ),
  get: vi.fn(async (id: string) => ({ id })),
};

function request(
  path: string,
  method = 'GET',
  body?: string,
  authenticated = true,
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authenticated) {
    headers.set('CF-Access-Client-Id', localServiceToken.clientId);
    headers.set('CF-Access-Client-Secret', localServiceToken.clientSecret);
  }
  return fetch(
    new Request(new URL(path, 'https://web.example.test'), {
      method,
      headers,
      body,
    }),
    {
      ...platform.env,
      BATCH_WORKFLOW: fakeWorkflow as unknown as Workflow<{ batchId: string }>,
    },
  );
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}
async function start(values = input) {
  const response = await request(
    '/api/batches',
    'POST',
    JSON.stringify(values),
  );
  expect(response.status).toBe(201);
  return batchSchema.parse(await response.json());
}
async function list() {
  const response = await request('/api/batches');
  expect(response.status).toBe(200);
  return batchListSchema.parse(await response.json()).batches;
}
function pending(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    status: 'pending',
  }));
}
beforeEach(async () => {
  fakeWorkflow.create.mockReset();
  fakeWorkflow.create.mockImplementation(async ({ id }) => ({ id }));
  fakeWorkflow.get.mockClear();
  platform = await getPlatformProxy<Env>({ configPath, persist: false });
  await migrate(drizzle(platform.env.DB), { migrationsFolder });
  await storeFixturePack(platform.env);
}, 60_000);
afterEach(async () => {
  await platform?.dispose();
}, 30_000);

describe('batch HTTP API with local D1 and a Workflow binding fake', () => {
  test('starts an authenticated batch exactly once and exposes the same queued record and all pending fixtures', async () => {
    await error(
      await request('/api/batches', 'POST', JSON.stringify(input), false),
      401,
      'unauthenticated',
    );
    expect(fakeWorkflow.create).not.toHaveBeenCalled();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const batch = await start();
    expect(batch).toEqual({
      ...input,
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      status: 'queued',
      progress: { completed: 0, failed: 0, checkPassed: 0, checkFailed: 0 },
      createdAt: expect.any(String),
    });
    expect(Date.parse(batch.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(batch.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(fakeWorkflow.create).toHaveBeenCalledExactlyOnceWith({
      id: batch.id,
      params: { batchId: batch.id },
    });
    const response = await request(`/api/batches/${batch.id}`);
    expect(response.status).toBe(200);
    expect(batchSchema.parse(await response.json())).toEqual(batch);
    const fixtures = await request(`/api/batches/${batch.id}/fixtures`);
    expect(fixtures.status).toBe(200);
    expect(fixtureListSchema.parse(await fixtures.json())).toEqual({
      batchId: batch.id,
      fixtures: pending(input.count),
    });
    expect(await list()).toEqual([batch]);
    expect(fakeWorkflow.create).toHaveBeenCalledTimes(1);
  });
  test('lists no batches before any start rather than leaking state from another database', async () => {
    expect(await list()).toEqual([]);
  });
  test('gives repeated identical starts different ids and lists the newest record first', async () => {
    const first = await start();
    // Cross timestamp resolution without replacing the clock used by Access.
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const second = await start();
    expect(second.id).not.toBe(first.id);
    expect(Date.parse(second.createdAt)).toBeGreaterThan(
      Date.parse(first.createdAt),
    );
    expect(await list()).toEqual([second, first]);
    expect(fakeWorkflow.create.mock.calls).toEqual([
      [{ id: first.id, params: { batchId: first.id } }],
      [{ id: second.id, params: { batchId: second.id } }],
    ]);
  });
  test.each([1, 1000])(
    'accepts count boundary %i and creates exactly that many ordered pending fixtures',
    async count => {
      const batch = await start({ ...input, count });
      expect(batch.count).toBe(count);
      const response = await request(`/api/batches/${batch.id}/fixtures`);
      expect(response.status).toBe(200);
      expect(fixtureListSchema.parse(await response.json())).toEqual({
        batchId: batch.id,
        fixtures: pending(count),
      });
    },
  );
  test('reruns into an independent queued batch with the original inputs and its own Workflow', async () => {
    const original = await start();
    const response = await request(`/api/batches/${original.id}/rerun`, 'POST');
    expect(response.status).toBe(201);
    const rerun = batchSchema.parse(await response.json());
    expect(rerun).toEqual({
      ...input,
      id: expect.any(String),
      status: 'queued',
      progress: { completed: 0, failed: 0, checkPassed: 0, checkFailed: 0 },
      createdAt: expect.any(String),
      rerunOf: original.id,
    });
    expect(rerun.id).not.toBe(original.id);
    expect(fakeWorkflow.create.mock.calls).toEqual([
      [{ id: original.id, params: { batchId: original.id } }],
      [{ id: rerun.id, params: { batchId: rerun.id } }],
    ]);
    for (const batch of [original, rerun]) {
      const saved = await request(`/api/batches/${batch.id}`);
      expect(saved.status).toBe(200);
      expect(batchSchema.parse(await saved.json())).toEqual(batch);
    }
    const fixtures = await request(`/api/batches/${rerun.id}/fixtures`);
    expect(fixtures.status).toBe(200);
    expect(fixtureListSchema.parse(await fixtures.json())).toEqual({
      batchId: rerun.id,
      fixtures: pending(input.count),
    });
    expect((await list()).map(batch => batch.id).sort()).toEqual(
      [original.id, rerun.id].sort(),
    );
  });
  test.each([
    { name: 'malformed JSON', body: '{', path: undefined },
    {
      name: 'count zero',
      body: JSON.stringify({ ...input, count: 0 }),
      path: ['count'],
    },
    {
      name: 'count over limit',
      body: JSON.stringify({ ...input, count: 1001 }),
      path: ['count'],
    },
    {
      name: 'fractional count',
      body: JSON.stringify({ ...input, count: 1.5 }),
      path: ['count'],
    },
    {
      name: 'invalid seed characters',
      body: JSON.stringify({ ...input, seed: 'bad seed!' }),
      path: ['seed'],
    },
    {
      name: 'overlong seed',
      body: JSON.stringify({ ...input, seed: 's'.repeat(65) }),
      path: ['seed'],
    },
    {
      name: 'missing seed',
      body: JSON.stringify({
        templateId: input.templateId,
        templateVersion: 1,
        count: 3,
      }),
      path: ['seed'],
    },
    {
      name: 'extra key',
      body: JSON.stringify({ ...input, extra: true }),
      path: [],
    },
  ])(
    'rejects $name before persisting or starting work and locates schema errors',
    async ({ body, path }) => {
      const failure = await error(
        await request('/api/batches', 'POST', body),
        400,
        'invalid_request',
      );
      if (path !== undefined) {
        expect(failure.details?.length).toBeGreaterThan(0);
        expect(
          failure.details?.every(detail => Array.isArray(detail.path)),
        ).toBe(true);
        expect(failure.details?.map(detail => detail.path)).toContainEqual(
          path,
        );
      }
      expect(fakeWorkflow.create).not.toHaveBeenCalled();
      expect(await list()).toEqual([]);
    },
  );
  test.each([
    { templateId: 'unknown-template', templateVersion: 1 },
    { templateId: 'fixture-report', templateVersion: 2 },
  ])(
    'rejects unknown template $templateId version $templateVersion without recording a batch',
    async template => {
      await error(
        await request(
          '/api/batches',
          'POST',
          JSON.stringify({ ...input, ...template }),
        ),
        404,
        'template_not_found',
      );
      expect(fakeWorkflow.create).not.toHaveBeenCalled();
      expect(await list()).toEqual([]);
    },
  );
  test.each([
    ['GET', '/api/batches/missing-batch'],
    ['GET', '/api/batches/missing-batch/fixtures'],
    ['POST', '/api/batches/missing-batch/rerun'],
  ])(
    'returns batch_not_found for %s %s instead of treating a missing batch as an empty one',
    async (method, path) => {
      await error(await request(path, method), 404, 'batch_not_found');
      expect(fakeWorkflow.create).not.toHaveBeenCalled();
    },
  );
  test('keeps unsupported methods and extra path segments out of batch handlers', async () => {
    const batch = await start();
    for (const [method, path] of [
      ['DELETE', '/api/batches'],
      ['POST', `/api/batches/${batch.id}`],
      ['POST', `/api/batches/${batch.id}/fixtures`],
      ['GET', `/api/batches/${batch.id}/rerun`],
      ['GET', `/api/batches/${batch.id}/extra`],
      ['POST', `/api/batches/${batch.id}/rerun/extra`],
    ] as const) {
      await error(await request(path, method), 404, 'not_found');
    }
    expect(fakeWorkflow.create).toHaveBeenCalledTimes(1);
    expect(await list()).toEqual([batch]);
  });
  test.each(['start', 'rerun'])(
    'marks the %s record failed with finishedAt when Workflow creation throws',
    async operation => {
      const original = operation === 'rerun' ? await start() : undefined;
      fakeWorkflow.create.mockClear();
      fakeWorkflow.create.mockRejectedValueOnce(
        new Error('Workflow deliberately unavailable'),
      );
      const response = original
        ? await request(`/api/batches/${original.id}/rerun`, 'POST')
        : await request('/api/batches', 'POST', JSON.stringify(input));
      await error(response, 503, 'batch_start_failed');
      expect(fakeWorkflow.create).toHaveBeenCalledTimes(1);
      const attempt = fakeWorkflow.create.mock.calls[0]?.[0];
      expect(attempt).toEqual({
        id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        params: { batchId: expect.any(String) },
      });
      expect(attempt?.params.batchId).toBe(attempt?.id);
      const saved = await request(`/api/batches/${attempt?.id}`);
      expect(saved.status).toBe(200);
      const failed = batchSchema.parse(await saved.json());
      expect(failed).toEqual({
        ...input,
        id: attempt?.id,
        status: 'failed',
        progress: { completed: 0, failed: 0, checkPassed: 0, checkFailed: 0 },
        createdAt: expect.any(String),
        finishedAt: expect.any(String),
        ...(original ? { rerunOf: original.id } : {}),
      });
      expect(Date.parse(failed.finishedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(failed.createdAt),
      );
      expect(await list()).toContainEqual(failed);
    },
  );
});
