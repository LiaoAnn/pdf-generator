import { createHash } from 'node:crypto';
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
import { fixtureTemplates } from '../templates/source.ts';
import { createFetchHandler } from '../worker.ts';
import { type FixtureJob, fixtureKey } from './fixture.ts';
import { type Printer, PrintFailure } from './printer.ts';
import { handleFixtureMessages } from './queue.ts';

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
  seed: 'slice3',
  count: 3,
};
const pdf = new Uint8Array([37, 80, 68, 70, 45, 10]);
const print = vi.fn<Printer['print']>();
const sendEvent = vi.fn(
  async (_event: { type: string; payload?: unknown }) => {},
);
const get = vi.fn(async (_id: string) => ({ sendEvent }));

function db() {
  return drizzle(platform.env.DB, { schema });
}
function deps() {
  return {
    db: db(),
    files: platform.env.FILES,
    templates: fixtureTemplates,
    printer: { print },
    workflow: { get },
  };
}
function message(batchId: string, index: number, attempts = 1) {
  return {
    id: `${batchId}-${index}-${attempts}`,
    timestamp: new Date(),
    attempts,
    body: {
      batchId,
      index,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      seed: input.seed,
    } satisfies FixtureJob,
    ack: vi.fn(),
    retry: vi.fn<(options?: { delaySeconds?: number }) => void>(),
  } satisfies Message<FixtureJob>;
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
async function start(count = 3) {
  const response = await request('/api/batches', 'POST', { ...input, count });
  expect(response.status).toBe(201);
  return batchSchema.parse(await response.json()).id;
}
async function progress(id: string) {
  const response = await request(`/api/batches/${id}`);
  expect(response.status).toBe(200);
  return batchSchema.parse(await response.json()).progress;
}
async function statuses(id: string) {
  const response = await request(`/api/batches/${id}/fixtures`);
  expect(response.status).toBe(200);
  return fixtureListSchema.parse(await response.json()).fixtures;
}
async function rows(id: string) {
  return db()
    .select()
    .from(schema.fixtures)
    .where(eq(schema.fixtures.batchId, id));
}
function acknowledged(msg: ReturnType<typeof message>) {
  expect(msg.ack).toHaveBeenCalledTimes(1);
  expect(msg.retry).not.toHaveBeenCalled();
}
function retried(msg: ReturnType<typeof message>) {
  expect(msg.ack).not.toHaveBeenCalled();
  expect(msg.retry).toHaveBeenCalledTimes(1);
  expect(msg.retry.mock.calls[0]?.[0]?.delaySeconds).toBeGreaterThan(0);
}

beforeEach(async () => {
  platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
  print.mockReset();
  print.mockImplementation(async job => ({
    pdf,
    pageCount: 2,
    gt: gtSchema.parse({ ...gtExample, source: job.source }),
  }));
  get.mockClear();
  sendEvent.mockReset();
  sendEvent.mockResolvedValue(undefined);
}, 60_000);
afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('HTTP progress rises only for settled fixtures; retries recover and exhausted fixtures expose their errors', async () => {
  const id = await start();
  const first = message(id, 0, 2);
  await handleFixtureMessages([first], deps());
  acknowledged(first);
  expect(await progress(id)).toEqual({ completed: 1, failed: 0 });
  expect(await statuses(id)).toEqual([
    { index: 0, status: 'completed' },
    { index: 1, status: 'pending' },
    { index: 2, status: 'pending' },
  ]);
  expect(get).not.toHaveBeenCalled();
  const [saved] = await rows(id);
  expect(saved).toMatchObject({
    index: 0,
    status: 'completed',
    attempts: 2,
    pageCount: 2,
  });
  for (const [file, column] of [
    ['data.json', 'dataSha256'],
    ['gt.json', 'gtSha256'],
    ['fixture.pdf', 'pdfSha256'],
  ] as const) {
    const object = await platform.env.FILES.get(fixtureKey(id, 0, file));
    expect(object).not.toBeNull();
    if (!object) throw new Error(`Missing ${file}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    expect(saved?.[column]).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    if (file === 'fixture.pdf') expect(bytes).toEqual(pdf);
  }
  print.mockRejectedValueOnce(
    new PrintFailure(503, 'browser_busy', 'browser_busy: try later'),
  );
  const transient = message(id, 1);
  await handleFixtureMessages([transient], deps());
  retried(transient);
  expect(await progress(id)).toEqual({ completed: 1, failed: 0 });
  expect((await rows(id)).map(row => row.index)).toEqual([0]);
  expect(get).not.toHaveBeenCalled();
  const recovered = message(id, 1, 2);
  await handleFixtureMessages([recovered], deps());
  acknowledged(recovered);
  expect(await progress(id)).toEqual({ completed: 2, failed: 0 });
  expect(get).not.toHaveBeenCalled();
  for (const attempt of [1, 2, 3]) {
    print.mockRejectedValueOnce(
      new PrintFailure(
        422,
        'invalid_layout',
        'invalid_layout: overlapping blocks',
      ),
    );
    const failing = message(id, 2, attempt);
    await handleFixtureMessages([failing], deps());
    if (attempt < 3) {
      retried(failing);
      expect(await progress(id)).toEqual({ completed: 2, failed: 0 });
      expect((await statuses(id))[2]).toEqual({ index: 2, status: 'pending' });
      expect(get).not.toHaveBeenCalled();
    } else acknowledged(failing);
  }
  expect(await progress(id)).toEqual({ completed: 2, failed: 1 });
  expect(await statuses(id)).toEqual([
    { index: 0, status: 'completed' },
    { index: 1, status: 'completed' },
    {
      index: 2,
      status: 'failed',
      error: expect.stringContaining('invalid_layout'),
    },
  ]);
  expect((await rows(id)).find(row => row.index === 2)).toMatchObject({
    attempts: 3,
    status: 'failed',
    error: expect.stringContaining('overlapping blocks'),
  });
  expect(get).toHaveBeenCalledWith(id);
  expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
});

test('unknown batches and duplicate deliveries ack without printing, overwriting rows, or writing R2', async () => {
  const unknown = message('missing', 0);
  await handleFixtureMessages([unknown], deps());
  acknowledged(unknown);
  expect(print).not.toHaveBeenCalled();
  expect(await rows('missing')).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
  const id = await start(2);
  await db()
    .insert(schema.fixtures)
    .values([
      {
        batchId: id,
        index: 0,
        attempts: 1,
        status: 'completed',
        pageCount: 2,
        pdfSha256: 'original',
      },
      {
        batchId: id,
        index: 1,
        attempts: 3,
        status: 'failed',
        error: 'original error',
      },
    ]);
  const before = await rows(id);
  const duplicates = [message(id, 0, 3), message(id, 1, 4)];
  await handleFixtureMessages(duplicates, deps());
  for (const duplicate of duplicates) acknowledged(duplicate);
  expect(print).not.toHaveBeenCalled();
  expect(await rows(id)).toEqual(before);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
});

const failures = [
  new PrintFailure(503, 'busy', 'busy: unavailable'),
  new PrintFailure(422, 'bad_layout', 'bad_layout: rejected'),
  new PrintFailure(0, 'unreachable', 'unreachable: connection lost'),
  new Error('unexpected printer crash'),
];
test.each(failures)(
  'retries then records any printer failure, including $message, at the attempt limit',
  async failure => {
    const id = await start(1);
    print.mockRejectedValue(failure);
    const second = message(id, 0, 2);
    await handleFixtureMessages([second], deps());
    retried(second);
    expect(await rows(id)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    const last = message(id, 0, 3);
    await handleFixtureMessages([last], deps());
    acknowledged(last);
    expect(await rows(id)).toEqual([
      expect.objectContaining({
        attempts: 3,
        status: 'failed',
        error: expect.stringContaining(failure.message),
      }),
    ]);
    expect(await statuses(id)).toEqual([
      {
        index: 0,
        status: 'failed',
        error: expect.stringContaining(failure.message),
      },
    ]);
    expect(get).toHaveBeenCalledWith(id);
    expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
  },
);

test.each(['get', 'sendEvent'] as const)(
  'a completion notification failure in %s preserves the settled row and ack',
  async operation => {
    const id = await start(1);
    const failure = new Error('workflow notification unavailable');
    if (operation === 'get') get.mockRejectedValueOnce(failure);
    else sendEvent.mockRejectedValueOnce(failure);
    const msg = message(id, 0);
    await handleFixtureMessages([msg], deps());
    acknowledged(msg);
    expect(await progress(id)).toEqual({ completed: 1, failed: 0 });
    expect(await rows(id)).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
  },
);

test('one failing message does not prevent later messages in the delivery from completing', async () => {
  const id = await start(3);
  print.mockImplementation(async job => {
    if (job.source.index === 0) throw new Error('first print fails');
    return {
      pdf,
      pageCount: 2,
      gt: gtSchema.parse({ ...gtExample, source: job.source }),
    };
  });
  const messages = [message(id, 0), message(id, 1), message(id, 2)];
  await handleFixtureMessages(messages, deps());
  const [first, second, third] = messages;
  if (!first || !second || !third) throw new Error('Missing test message');
  retried(first);
  acknowledged(second);
  acknowledged(third);
  expect(await progress(id)).toEqual({ completed: 2, failed: 0 });
  expect(await statuses(id)).toEqual([
    { index: 0, status: 'pending' },
    { index: 1, status: 'completed' },
    { index: 2, status: 'completed' },
  ]);
  expect(get).not.toHaveBeenCalled();
});
