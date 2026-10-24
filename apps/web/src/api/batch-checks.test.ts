import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  batchSchema,
  fixtureListSchema,
  type GroundTruth,
  gtSchema,
} from '@pdf-generator/contract';
import type { Difference, SelfCheckReport } from '@pdf-generator/self-check';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { type FixtureJob, fixtureKey } from '../batch/fixture.ts';
import { type Printer, PrintFailure } from '../batch/printer.ts';
import { handleFixtureMessages } from '../batch/queue.ts';
import * as schema from '../db/schema.ts';
import {
  fixtureTemplates,
  storeFixturePack,
} from '../templates/fixture-pack.ts';
import { createFetchHandler } from '../worker.ts';

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
  seed: 't16-1-checks',
  count: 1,
};
const pdf = new Uint8Array([37, 80, 68, 70, 45, 10]);
const print = vi.fn<Printer['print']>();
const check = vi.fn(
  async (_pdf: Uint8Array, _gt: GroundTruth): Promise<SelfCheckReport> => ({
    ok: true,
    differences: [],
  }),
);
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
const passedCheck = { passed: true, differences: 0 };
const textDecoder = new TextDecoder();

function db() {
  return drizzle(platform.env.DB, { schema });
}
function deps() {
  return {
    db: db(),
    files: platform.env.FILES,
    templates: fixtureTemplates,
    printer: { print },
    workflow: { get: async () => ({ sendEvent: async () => {} }) },
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
    retry: vi.fn(),
  } satisfies Message<FixtureJob>;
}
function request(path: string, method = 'GET', body?: unknown) {
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
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
}
async function storedCheck(batchId: string, index: number) {
  const object = await platform.env.FILES.get(
    fixtureKey(batchId, index, 'check.json'),
  );
  if (!object) throw new Error(`missing check.json for ${index}`);
  return new Uint8Array(await object.arrayBuffer());
}
function printed(job: { source: GroundTruth['source'] }) {
  return {
    pdf,
    pageCount: 2,
    gt: gtSchema.parse({ ...gtExample, source: job.source }),
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
  print.mockReset();
  print.mockImplementation(async job => printed(job));
  check.mockReset();
  check.mockResolvedValue(passingReport);
}, 60_000);
afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('lists stored self-check results and omits check when none was stored', async () => {
  // Regression: the list drops check, reports the wrong pass flag or
  // difference count, or invents a check for a pending, failed, or pre-ticket
  // row. Columns alone are enough: a completed row with no check.json still
  // reports checkPassed and checkDifferences.
  const id = await start(6);
  print.mockImplementation(async job => {
    if (job.source.index === 3) {
      throw new PrintFailure(
        422,
        'invalid_layout',
        'invalid_layout: overlapping blocks',
      );
    }
    return printed(job);
  });
  check.mockImplementation(async (_pdf, gt) =>
    gt.source.index === 1 ? mismatchReport : passingReport,
  );
  await handleFixtureMessages(
    [message(id, 0), message(id, 1), message(id, 3, 3)],
    deps(),
  );
  await db()
    .insert(schema.fixtures)
    .values([
      {
        batchId: id,
        index: 4,
        status: 'completed',
        attempts: 1,
        pageCount: 1,
      },
      {
        batchId: id,
        index: 5,
        status: 'completed',
        attempts: 1,
        pageCount: 1,
        checkPassed: false,
        checkDifferences: 4,
      },
    ]);
  const response = await request(`/api/batches/${id}/fixtures`);
  expect(response.status).toBe(200);
  expect(fixtureListSchema.parse(await response.json())).toEqual({
    batchId: id,
    fixtures: [
      { index: 0, status: 'completed', check: passedCheck },
      {
        index: 1,
        status: 'completed',
        check: {
          passed: false,
          differences: mismatchReport.differences.length,
        },
      },
      { index: 2, status: 'pending' },
      {
        index: 3,
        status: 'failed',
        error: expect.stringContaining('invalid_layout'),
      },
      { index: 4, status: 'completed' },
      {
        index: 5,
        status: 'completed',
        check: { passed: false, differences: 4 },
      },
    ],
  });
});

test('returns the stored check.json bytes, including every difference of a failed check', async () => {
  // Regression: the check route is missing, re-serializes the stored object,
  // or withholds the differences of a fixture whose self-check failed.
  const id = await start(2);
  check.mockImplementation(async (_pdf, gt) =>
    gt.source.index === 1 ? mismatchReport : passingReport,
  );
  await handleFixtureMessages([message(id, 0), message(id, 1)], deps());
  for (const [index, report] of [
    [1, mismatchReport],
    [0, passingReport],
  ] as const) {
    const response = await request(
      `/api/batches/${id}/fixtures/${index}/check`,
    );
    expect(response.status, `fixture ${index}`).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/json\b/i,
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body, `fixture ${index} bytes`).toEqual(
      await storedCheck(id, index),
    );
    expect(JSON.parse(textDecoder.decode(body)), `fixture ${index}`).toEqual(
      report,
    );
  }
});

test('returns batch_not_found for a check of an unknown batch', async () => {
  // Regression: a missing batch is a generic not_found or check_not_found,
  // including when the index itself would also be rejected.
  await error(
    await request('/api/batches/missing-batch/fixtures/0/check'),
    404,
    'batch_not_found',
  );
  await error(
    await request('/api/batches/missing-batch/fixtures/nope/check'),
    404,
    'batch_not_found',
  );
});

test('returns fixture_not_found when the index is not a fixture of the batch', async () => {
  // Regression: a negative, non-integer, or out-of-range index is read as
  // another fixture (parseInt("1.5") === 1) or reported as check_not_found.
  const id = await start(2);
  for (const index of ['-1', '1.5', 'nope', '2']) {
    await error(
      await request(`/api/batches/${id}/fixtures/${index}/check`),
      404,
      'fixture_not_found',
    );
  }
});

test('returns check_not_found when the fixture has no stored check.json', async () => {
  // Regression: a pending, failed, or completed fixture without check.json is
  // answered with a made-up report, or with not_found / fixture_not_found.
  // D1 check columns are not a substitute for the stored object.
  const id = await start(4);
  await db()
    .insert(schema.fixtures)
    .values([
      {
        batchId: id,
        index: 1,
        status: 'failed',
        attempts: 3,
        error: 'printer exploded',
      },
      {
        batchId: id,
        index: 2,
        status: 'completed',
        attempts: 1,
        pageCount: 1,
      },
      {
        batchId: id,
        index: 3,
        status: 'completed',
        attempts: 1,
        pageCount: 1,
        checkPassed: true,
        checkDifferences: 0,
      },
    ]);
  for (const index of [0, 1, 2, 3]) {
    await error(
      await request(`/api/batches/${id}/fixtures/${index}/check`),
      404,
      'check_not_found',
    );
  }
});
