import { fileURLToPath } from 'node:url';
import {
  batchSchema,
  fixtureListSchema,
  gtSchema,
} from '@pdf-generator/contract';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import * as schema from '../db/schema.ts';
import {
  fixtureTemplates,
  storeFixturePack,
} from '../templates/fixture-pack.ts';
import { createFetchHandler } from '../worker.ts';
import type { FixtureJob } from './fixture.ts';
import type { Printer } from './printer.ts';
import { handleFixtureMessages } from './queue.ts';
import { type BatchSteps, runBatch } from './workflow.ts';

// Node has no WorkflowEntrypoint runtime; runBatch is exercised with real local
// D1/R2 and injected step/queue interfaces, without constructing the entrypoint.
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
const local = createLocalAccess();
const fetch = createFetchHandler({
  pages: async () => new Response('Unexpected pages', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
const input = {
  templateId: 'fixture-report',
  templateVersion: 1,
  seed: 'workflow-seed',
};
function db() {
  return drizzle(platform.env.DB, { schema });
}
async function request(path: string, method = 'GET', body?: unknown) {
  return fetch(
    new Request(`https://web.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      ...platform.env,
      BATCH_WORKFLOW: {
        create: async ({ id }: { id: string }) => ({ id }),
      } as unknown as Workflow<{ batchId: string }>,
    },
  );
}
async function start(count: number) {
  const response = await request('/api/batches', 'POST', { ...input, count });
  expect(response.status).toBe(201);
  return batchSchema.parse(await response.json()).id;
}
async function batch(id: string) {
  const response = await request(`/api/batches/${id}`);
  expect(response.status).toBe(200);
  return batchSchema.parse(await response.json());
}
function steps(onWait: () => Promise<unknown> = async () => undefined) {
  const names: string[] = [];
  let inStep = false;
  const cache = new Map<string, unknown>();
  const step: BatchSteps = {
    async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      // Simulate durable replay: a repeated name returns the saved result.
      if (cache.has(name)) return cache.get(name) as T;
      inStep = true;
      try {
        const result = await callback();
        cache.set(name, result);
        return result;
      } finally {
        inStep = false;
      }
    },
    waitForEvent: vi.fn(async (name, _options) => {
      names.push(name);
      if (cache.has(name)) return cache.get(name);
      const result = await onWait();
      cache.set(name, result);
      return result;
    }),
  };
  return { step, names, insideStep: () => inStep };
}
async function settle(id: string, count: number, failed = false) {
  const rows = Array.from({ length: count }, (_, index) => ({
    batchId: id,
    index,
    attempts: failed ? 3 : 1,
    status: failed ? ('failed' as const) : ('completed' as const),
    ...(failed ? { error: 'printer exhausted' } : { pageCount: 1 }),
  }));
  // Each row binds five values; keep inserts below D1's 100-parameter limit.
  for (let offset = 0; offset < rows.length; offset += 10) {
    await db()
      .insert(schema.fixtures)
      .values(rows.slice(offset, offset + 10));
  }
}
function finished(
  value: Awaited<ReturnType<typeof batch>>,
  status: 'completed' | 'failed',
) {
  expect(value.status).toBe(status);
  expect(value.finishedAt).toEqual(expect.any(String));
  expect(Date.parse(value.finishedAt ?? '')).toBeGreaterThanOrEqual(
    Date.parse(value.createdAt),
  );
  expect(Date.parse(value.finishedAt ?? '')).toBeLessThanOrEqual(Date.now());
}

beforeEach(async () => {
  platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
  await storeFixturePack(platform.env);
}, 60_000);
afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('a started 100-fixture batch exposes rising HTTP progress and finishes with 100 completed fixtures', async () => {
  const id = await start(100);
  const jobs: FixtureJob[] = [];
  const observed: number[] = [];
  const context = steps(async () => {
    expect((await batch(id)).status).toBe('running');
    const pending = jobs.splice(0, 25);
    expect(pending).toHaveLength(25);
    const messages = pending.map((body, index) => ({
      body,
      id: String(index),
      timestamp: new Date(),
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    await handleFixtureMessages(messages, {
      db: db(),
      files: platform.env.FILES,
      templates: fixtureTemplates,
      printers: {
        for: (_batchId: string): Printer => ({
          print: async job => ({
            pageCount: 1,
            pdf: new Uint8Array([37, 80, 68, 70]),
            gt: gtSchema.parse({ ...gtExample, source: job.source }),
          }),
        }),
        close: async (_batchId: string) => {},
      },
      workflow: { get: async () => ({ sendEvent: async () => {} }) },
      checker: {
        check: async () => ({ ok: true, differences: [] }),
      },
    });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    observed.push((await batch(id)).progress.completed);
  });
  const sendBatch = vi.fn(async (messages: Iterable<{ body: FixtureJob }>) => {
    expect(context.insideStep()).toBe(true);
    expect((await batch(id)).status).toBe('running');
    jobs.push(...Array.from(messages, message => message.body));
  });
  await runBatch(
    id,
    context.step,
    { db: db(), queue: { sendBatch } },
    { waitTimeout: '1 second', maxWaits: 5 },
  );
  expect(observed).toEqual([25, 50, 75, 100]);
  const result = await batch(id);
  finished(result, 'completed');
  expect(result.progress).toEqual({
    completed: 100,
    failed: 0,
    checkPassed: 100,
    checkFailed: 0,
  });
  const response = await request(`/api/batches/${id}/fixtures`);
  expect(response.status).toBe(200);
  expect(fixtureListSchema.parse(await response.json()).fixtures).toEqual(
    Array.from({ length: 100 }, (_, index) => ({
      index,
      status: 'completed',
      check: { passed: true, differences: 0 },
    })),
  );
  expect(context.step.waitForEvent).toHaveBeenCalledWith(expect.any(String), {
    type: 'fixtures-done',
    timeout: '1 second',
  });
  expect(new Set(context.names).size).toBe(context.names.length);
}, 60_000);

test('large batches enqueue each exact job once in durable steps of at most 100, and replay does not enqueue again', async () => {
  const id = await start(205);
  const chunks: FixtureJob[][] = [];
  const context = steps(async () => {
    await settle(id, 205);
  });
  const sendBatch = vi.fn(async (messages: Iterable<{ body: FixtureJob }>) => {
    expect(context.insideStep()).toBe(true);
    expect((await batch(id)).status).toBe('running');
    chunks.push(Array.from(messages, message => message.body));
  });
  const deps = { db: db(), queue: { sendBatch } };
  await runBatch(id, context.step, deps, {
    waitTimeout: '1 second',
    maxWaits: 2,
  });
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  for (const chunk of chunks) {
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(100);
  }
  expect(chunks.flat()).toEqual(
    Array.from({ length: 205 }, (_, index) => ({
      batchId: id,
      ...input,
      index,
    })),
  );
  expect(new Set(context.names).size).toBe(context.names.length);
  const calls = sendBatch.mock.calls.length;
  await runBatch(id, context.step, deps, {
    waitTimeout: '1 second',
    maxWaits: 2,
  });
  expect(sendBatch).toHaveBeenCalledTimes(calls);
  finished(await batch(id), 'completed');
});

test('a timed-out wait rechecks progress and completes even when every fixture failed', async () => {
  const id = await start(2);
  let waits = 0;
  const context = steps(async () => {
    waits++;
    if (waits === 1) throw new Error('wait timeout');
    await settle(id, 2, true);
    throw new Error('event lost after fixtures were persisted');
  });
  const sendBatch = vi.fn(
    async (_messages: Iterable<{ body: FixtureJob }>) => {},
  );
  await runBatch(
    id,
    context.step,
    { db: db(), queue: { sendBatch } },
    { waitTimeout: '2 seconds', maxWaits: 3 },
  );
  expect(waits).toBe(2);
  finished(await batch(id), 'completed');
  expect((await batch(id)).progress).toEqual({
    completed: 0,
    failed: 2,
    checkPassed: 0,
    checkFailed: 0,
  });
  expect(new Set(context.names).size).toBe(context.names.length);
  for (const [, options] of vi.mocked(context.step.waitForEvent).mock.calls) {
    expect(options).toEqual({ type: 'fixtures-done', timeout: '2 seconds' });
  }
});

test.each(['event', 'timeout'] as const)(
  'pending fixtures after maxWaits %s waits fail the batch instead of hanging',
  async kind => {
    const id = await start(1);
    const context = steps(async () => {
      if (kind === 'timeout') throw new Error('wait timeout');
    });
    const sendBatch = vi.fn(
      async (_messages: Iterable<{ body: FixtureJob }>) => {},
    );
    await runBatch(
      id,
      context.step,
      { db: db(), queue: { sendBatch } },
      { waitTimeout: '1 second', maxWaits: 2 },
    );
    expect(context.step.waitForEvent).toHaveBeenCalledTimes(2);
    finished(await batch(id), 'failed');
    expect((await batch(id)).progress).toEqual({
      completed: 0,
      failed: 0,
      checkPassed: 0,
      checkFailed: 0,
    });
    expect(new Set(context.names).size).toBe(context.names.length);
  },
);

test('already-settled fixtures complete without waiting for an event that may have been lost', async () => {
  const id = await start(1);
  await settle(id, 1);
  const context = steps();
  await runBatch(id, context.step, {
    db: db(),
    queue: { sendBatch: vi.fn(async () => {}) },
  });
  expect(context.step.waitForEvent).not.toHaveBeenCalled();
  finished(await batch(id), 'completed');
});

test('an unknown batch rejects without enqueuing any work', async () => {
  const context = steps();
  const sendBatch = vi.fn(async () => {});
  await expect(
    runBatch('missing', context.step, { db: db(), queue: { sendBatch } }),
  ).rejects.toThrow();
  expect(sendBatch).not.toHaveBeenCalled();
  expect(context.step.waitForEvent).not.toHaveBeenCalled();
  expect(await db().select().from(schema.batches)).toEqual([]);
});

test('a queue send error rejects and records failed with finishedAt rather than leaving the batch running', async () => {
  const id = await start(101);
  const cause = new Error('queue unavailable');
  const context = steps();
  const sendBatch = vi.fn(async () => {
    throw cause;
  });
  await expect(
    runBatch(id, context.step, { db: db(), queue: { sendBatch } }),
  ).rejects.toThrow('queue unavailable');
  expect(sendBatch).toHaveBeenCalled();
  expect(context.step.waitForEvent).not.toHaveBeenCalled();
  finished(await batch(id), 'failed');
  expect(
    await db()
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.batchId, id)),
  ).toEqual([]);
});
