import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  batchSchema,
  fixtureListSchema,
  type GroundTruth,
  gtSchema,
} from '@pdf-generator/contract';
import type { Difference, SelfCheckReport } from '@pdf-generator/self-check';
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
import { type FixtureFile, type FixtureJob, fixtureKey } from './fixture.ts';
import { type Printer, PrintFailure } from './printer.ts';
import { consumeFixtures, handleFixtureMessages } from './queue.ts';

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
const forBatch = vi.fn((_batchId: string): Printer => ({ print }));
const closeBatch = vi.fn<(batchId: string) => Promise<void>>();
const sendEvent = vi.fn(
  async (_event: { type: string; payload?: unknown }) => {},
);
const get = vi.fn(async (_id: string) => ({ sendEvent }));
const check = vi.fn(
  async (
    _pdf: Uint8Array,
    _gt: GroundTruth,
    _fonts: readonly string[],
  ): Promise<SelfCheckReport> => ({
    ok: true,
    differences: [],
  }),
);

function db() {
  return drizzle(platform.env.DB, { schema });
}
function deps() {
  return {
    db: db(),
    files: platform.env.FILES,
    templates: fixtureTemplates,
    printers: { for: forBatch, close: closeBatch },
    workflow: { get },
    checker: { check },
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
const textDecoder = new TextDecoder();
async function storedText(batchId: string, index: number, file: FixtureFile) {
  const object = await platform.env.FILES.get(fixtureKey(batchId, index, file));
  if (!object) return null;
  return textDecoder.decode(await object.arrayBuffer());
}
async function storedPdf(batchId: string, index: number) {
  const object = await platform.env.FILES.get(
    fixtureKey(batchId, index, 'fixture.pdf'),
  );
  if (!object) throw new Error(`missing fixture.pdf for ${index}`);
  return new Uint8Array(await object.arrayBuffer());
}
async function storedGroundTruth(batchId: string, index: number) {
  const text = await storedText(batchId, index, 'gt.json');
  if (text === null) throw new Error(`missing gt.json for ${index}`);
  return gtSchema.parse(JSON.parse(text));
}
async function recordedCheck(batchId: string, index: number) {
  const row = (await rows(batchId)).find(item => item.index === index);
  return {
    status: row?.status ?? null,
    checkPassed: row?.checkPassed,
    checkDifferences: row?.checkDifferences,
    checkJson: await storedText(batchId, index, 'check.json'),
  };
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
  forBatch.mockReset();
  forBatch.mockImplementation(() => ({ print }));
  closeBatch.mockReset();
  closeBatch.mockResolvedValue(undefined);
  print.mockReset();
  print.mockImplementation(async job => ({
    pdf,
    pageCount: 2,
    gt: gtSchema.parse({ ...gtExample, source: job.source }),
  }));
  get.mockClear();
  sendEvent.mockReset();
  sendEvent.mockResolvedValue(undefined);
  check.mockReset();
  check.mockResolvedValue({ ok: true, differences: [] });
}, 60_000);
afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('HTTP progress rises only for settled fixtures; retries recover and exhausted fixtures expose their errors', async () => {
  const id = await start();
  const first = message(id, 0, 2);
  await handleFixtureMessages([first], deps());
  acknowledged(first);
  expect(await progress(id)).toEqual({
    completed: 1,
    failed: 0,
    checkPassed: 1,
    checkFailed: 0,
  });
  expect(await statuses(id)).toEqual([
    {
      index: 0,
      status: 'completed',
      check: { passed: true, differences: 0 },
    },
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
  expect(await progress(id)).toEqual({
    completed: 1,
    failed: 0,
    checkPassed: 1,
    checkFailed: 0,
  });
  expect((await rows(id)).map(row => row.index)).toEqual([0]);
  expect(get).not.toHaveBeenCalled();
  const recovered = message(id, 1, 2);
  await handleFixtureMessages([recovered], deps());
  acknowledged(recovered);
  expect(await progress(id)).toEqual({
    completed: 2,
    failed: 0,
    checkPassed: 2,
    checkFailed: 0,
  });
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
      expect(await progress(id)).toEqual({
        completed: 2,
        failed: 0,
        checkPassed: 2,
        checkFailed: 0,
      });
      expect((await statuses(id))[2]).toEqual({ index: 2, status: 'pending' });
      expect(get).not.toHaveBeenCalled();
    } else acknowledged(failing);
  }
  expect(await progress(id)).toEqual({
    completed: 2,
    failed: 1,
    checkPassed: 2,
    checkFailed: 0,
  });
  expect(await statuses(id)).toEqual([
    {
      index: 0,
      status: 'completed',
      check: { passed: true, differences: 0 },
    },
    {
      index: 1,
      status: 'completed',
      check: { passed: true, differences: 0 },
    },
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
  // The uploaded fixture-report zip is under templates/; fixtures are here.
  expect(
    (await platform.env.FILES.list({ prefix: 'batches/' })).objects,
  ).toEqual([]);
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
  // The uploaded fixture-report zip is under templates/; fixtures are here.
  expect(
    (await platform.env.FILES.list({ prefix: 'batches/' })).objects,
  ).toEqual([]);
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
    expect(await progress(id)).toEqual({
      completed: 1,
      failed: 0,
      checkPassed: 1,
      checkFailed: 0,
    });
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
  expect(await progress(id)).toEqual({
    completed: 2,
    failed: 0,
    checkPassed: 2,
    checkFailed: 0,
  });
  expect(await statuses(id)).toEqual([
    { index: 0, status: 'pending' },
    {
      index: 1,
      status: 'completed',
      check: { passed: true, differences: 0 },
    },
    {
      index: 2,
      status: 'completed',
      check: { passed: true, differences: 0 },
    },
  ]);
  expect(get).not.toHaveBeenCalled();
});

const textDifference: Difference = {
  kind: 'text',
  page: 1,
  blockId: 'title',
  expected: '臺灣示範股份有限公司 月報',
  actual: '月報',
  message: 'Block title on page 1: the PDF text is not the ground truth',
};
const pageDifference: Difference = {
  kind: 'page_count',
  expected: 2,
  actual: 1,
  message: 'The PDF has 1 page; gt.json has 2',
};
const passingReport: SelfCheckReport = { ok: true, differences: [] };
const mismatchReport: SelfCheckReport = {
  ok: false,
  differences: [textDifference, pageDifference],
};

test('records each fixture self-check in R2 and D1, including a mismatch that stays completed', async () => {
  // Regression: skipping the check, writing it off fixtureKey(..., 'check.json'),
  // or failing the fixture when gt and the PDF differ ships a bad fixture silently.
  const id = await start(2);
  const printed = new Map<number, { pdf: Uint8Array; gt: GroundTruth }>();
  print.mockImplementation(async job => {
    const value = {
      pdf: new Uint8Array([37, 80, 68, 70, job.source.index]),
      pageCount: 2,
      gt: gtSchema.parse({ ...gtExample, source: job.source }),
    };
    printed.set(job.source.index, value);
    return { ...value, pdf: value.pdf.slice() };
  });
  const inspect = vi.fn(
    async (_pdf: Uint8Array, gt: GroundTruth, _fonts: readonly string[]) =>
      gt.source.index === 0 ? passingReport : mismatchReport,
  );
  const messages = [message(id, 0), message(id, 1)];
  await handleFixtureMessages(messages, {
    ...deps(),
    checker: { check: inspect },
  });

  expect(await recordedCheck(id, 0)).toEqual({
    status: 'completed',
    checkPassed: true,
    checkDifferences: 0,
    checkJson: `${JSON.stringify(passingReport, null, 2)}\n`,
  });
  expect(await recordedCheck(id, 1)).toEqual({
    status: 'completed',
    checkPassed: false,
    checkDifferences: mismatchReport.differences.length,
    checkJson: `${JSON.stringify(mismatchReport, null, 2)}\n`,
  });
  for (const index of [0, 1]) {
    const value = printed.get(index);
    if (!value) throw new Error(`print did not return a PDF for ${index}`);
    expect(await storedPdf(id, index)).toEqual(value.pdf);
    expect(await storedGroundTruth(id, index)).toEqual(value.gt);
    expect(inspect).toHaveBeenCalledWith(value.pdf, value.gt, []);
  }
  for (const msg of messages) acknowledged(msg);
  expect(await progress(id)).toEqual({
    completed: 2,
    failed: 0,
    checkPassed: 1,
    checkFailed: 1,
  });
  expect(get).toHaveBeenCalledWith(id);
  expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
});

test('retries a throwing checker, then fails the fixture with null check columns and no check.json', async () => {
  // Regression: a checker exception is stored as a completed pass, or a failed
  // fixture keeps check.json / non-null check columns.
  const id = await start(1);
  const failure = new Error('self-check exploded');
  const bytes = new Uint8Array([37, 80, 68, 70, 9]);
  let printedGt: GroundTruth | undefined;
  print.mockImplementation(async job => {
    printedGt = gtSchema.parse({ ...gtExample, source: job.source });
    return { pdf: bytes.slice(), pageCount: 2, gt: printedGt };
  });
  const inspect = vi.fn(async () => {
    throw failure;
  });
  const withChecker = () => ({ ...deps(), checker: { check: inspect } });

  for (const attempt of [1, 2]) {
    const msg = message(id, 0, attempt);
    await handleFixtureMessages([msg], withChecker());
    expect(printedGt, 'printed gt').toBeDefined();
    expect(inspect).toHaveBeenCalledWith(bytes, printedGt, []);
    retried(msg);
    expect(await rows(id)).toEqual([]);
    expect(await storedText(id, 0, 'check.json')).toBeNull();
  }
  const last = message(id, 0, 3);
  await handleFixtureMessages([last], withChecker());
  acknowledged(last);
  const row = (await rows(id)).find(item => item.index === 0);
  expect(row).toMatchObject({
    status: 'failed',
    attempts: 3,
    error: expect.stringContaining('self-check exploded'),
  });
  expect(row?.checkPassed, 'failed checkPassed').toBeNull();
  expect(row?.checkDifferences, 'failed checkDifferences').toBeNull();
  expect(await storedText(id, 0, 'check.json')).toBeNull();
  expect(await progress(id)).toEqual({
    completed: 0,
    failed: 1,
    checkPassed: 0,
    checkFailed: 0,
  });
  expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
});

test('a printer failure leaves null check columns and does not write check.json', async () => {
  // Regression: the print-failure path still runs the checker or records a
  // check for a PDF the printer rejected.
  const id = await start(1);
  const inspect = vi.fn(async () => passingReport);
  print.mockRejectedValue(new PrintFailure(503, 'busy', 'busy: unavailable'));
  const early = message(id, 0, 1);
  await handleFixtureMessages([early], {
    ...deps(),
    checker: { check: inspect },
  });
  retried(early);
  expect(inspect).not.toHaveBeenCalled();
  expect(await storedText(id, 0, 'check.json')).toBeNull();

  const last = message(id, 0, 3);
  await handleFixtureMessages([last], {
    ...deps(),
    checker: { check: inspect },
  });
  acknowledged(last);
  const row = (await rows(id)).find(item => item.index === 0);
  expect(row).toMatchObject({
    status: 'failed',
    attempts: 3,
    error: expect.stringContaining('busy: unavailable'),
  });
  expect(row?.checkPassed, 'failed checkPassed').toBeNull();
  expect(row?.checkDifferences, 'failed checkDifferences').toBeNull();
  expect(await storedText(id, 0, 'check.json')).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
});

test('the queue handler fails an unreadable PDF instead of completing it', async () => {
  // Regression: consumeFixtures supplies a checker that does not read the PDF,
  // so a fixture whose bytes are not a PDF is stored as completed.
  const id = await start(1);
  const garbage = new Uint8Array([1, 2, 3, 4]);
  const msg = message(id, 0, 3);
  await consumeFixtures(
    { messages: [msg] } as unknown as MessageBatch<FixtureJob>,
    {
      ...platform.env,
      PRINT_TOKEN: 'test-token',
      PRINT: {
        fetch: async () =>
          Response.json({
            pageCount: 2,
            pdf: btoa(String.fromCharCode(...garbage)),
            gt: gtSchema.parse({
              ...gtExample,
              source: {
                templateId: input.templateId,
                templateVersion: input.templateVersion,
                seed: input.seed,
                index: 0,
              },
            }),
          }),
      } as unknown as Env['PRINT'],
      BATCH_WORKFLOW: {
        get: async () => ({ sendEvent: async () => {} }),
      } as unknown as Env['BATCH_WORKFLOW'],
    },
  );
  const row = (await rows(id)).find(item => item.index === 0);
  expect(row).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Invalid PDF'),
  });
  expect(row?.checkPassed, 'failed checkPassed').toBeNull();
  expect(row?.checkDifferences, 'failed checkDifferences').toBeNull();
  expect(await storedText(id, 0, 'check.json')).toBeNull();
  acknowledged(msg);
});

test('selects each batch printer and closes only after its final successful fixture', async () => {
  const a = await start(2);
  const b = await start(1);
  const printA = vi.fn<Printer['print']>(job => print(job));
  const printB = vi.fn<Printer['print']>(job => print(job));
  forBatch.mockImplementation(id => ({ print: id === a ? printA : printB }));
  const first = message(a, 0);
  await handleFixtureMessages([first], deps());
  expect(forBatch).toHaveBeenCalledWith(a);
  acknowledged(first);
  expect(closeBatch).not.toHaveBeenCalled();
  const other = message(b, 0);
  await handleFixtureMessages([other], deps());
  expect(forBatch).toHaveBeenCalledWith(b);
  expect(printA).toHaveBeenCalledTimes(1);
  expect(printB).toHaveBeenCalledTimes(1);
  expect(closeBatch.mock.calls).toEqual([[b]]);
  acknowledged(other);
  const last = message(a, 1);
  await handleFixtureMessages([last], deps());
  acknowledged(last);
  expect(closeBatch.mock.calls).toEqual([[b], [a]]);
  expect(sendEvent).toHaveBeenCalledTimes(2);
});

test('keeps sessions for retries and closes when the final fixture exhausts its attempts', async () => {
  const id = await start(1);
  print.mockRejectedValue(
    new PrintFailure(422, 'invalid_layout', 'bad layout'),
  );
  const retry = message(id, 0, 2);
  await handleFixtureMessages([retry], deps());
  expect(forBatch).toHaveBeenCalledWith(id);
  retried(retry);
  expect(closeBatch).not.toHaveBeenCalled();
  const last = message(id, 0, 3);
  await handleFixtureMessages([last], deps());
  acknowledged(last);
  expect(await rows(id)).toEqual([
    expect.objectContaining({ status: 'failed' }),
  ]);
  expect(closeBatch.mock.calls).toEqual([[id]]);
  expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
});

test.each([false, true])(
  'closes missing batches without printing even when cleanup rejects (%s)',
  async rejects => {
    if (rejects)
      closeBatch.mockRejectedValueOnce(new Error('cleanup unavailable'));
    const msg = message('missing-batch', 0);
    await handleFixtureMessages([msg], deps());
    expect(closeBatch).toHaveBeenCalledWith('missing-batch');
    acknowledged(msg);
    expect(forBatch).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  },
);

test.each(['completed', 'failed'] as const)(
  'cleanup rejection preserves the final %s row, one ack, and the workflow event',
  async status => {
    const id = await start(1);
    if (status === 'failed') print.mockRejectedValue(new Error('print failed'));
    closeBatch.mockRejectedValueOnce(new Error('cleanup unavailable'));
    const msg = message(id, 0, 3);
    await handleFixtureMessages([msg], deps());
    expect(closeBatch).toHaveBeenCalledWith(id);
    acknowledged(msg);
    expect(await rows(id)).toEqual([expect.objectContaining({ status })]);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
  },
);

test('consumer retains sessions across deliveries but isolates batches and closes exhausted batches', async () => {
  const a = await start(1);
  const b = await start(1);
  const sessions: (string | null)[] = [];
  const deleted: string[] = [];
  let next = 0;
  const env = {
    ...platform.env,
    PRINT_TOKEN: 'consumer-session-test',
    PRINT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const sent = new Request(input, init);
        if (sent.method === 'DELETE') {
          deleted.push(sent.url);
          return new Response(null, { status: 204 });
        }
        const session = sent.headers.get('x-browser-session');
        sessions.push(session);
        // Retryable print failure retains a healthy browser session.
        return Response.json(
          { error: { code: 'invalid_layout', message: 'bad layout' } },
          {
            status: 422,
            headers: {
              'x-browser-session':
                session === 'new' ? `session-${next++}` : (session ?? ''),
            },
          },
        );
      },
    } as Env['PRINT'],
    BATCH_WORKFLOW: { get } as unknown as Env['BATCH_WORKFLOW'],
  };
  async function deliver(id: string, attempt: number) {
    const msg = message(id, 0, attempt);
    await consumeFixtures(
      { messages: [msg] } as unknown as MessageBatch<FixtureJob>,
      env,
    );
    return msg;
  }
  retried(await deliver(a, 1));
  retried(await deliver(a, 2));
  retried(await deliver(b, 1));
  expect(sessions).toEqual(['new', 'session-0', 'new']);
  expect(deleted).toEqual([]);
  acknowledged(await deliver(a, 3));
  expect(deleted).toEqual(['https://print.internal/session/session-0']);
  acknowledged(await deliver(b, 3));
  expect(deleted.sort()).toEqual([
    'https://print.internal/session/session-0',
    'https://print.internal/session/session-1',
  ]);
});
