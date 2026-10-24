import { fileURLToPath } from 'node:url';
import { apiErrorSchema, batchSchema, gtSchema } from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import type { Checker } from '../batch/check.ts';
import {
  type FixtureFile,
  type FixtureJob,
  fixtureKey,
} from '../batch/fixture.ts';
import type { Printer } from '../batch/printer.ts';
import { type FixtureDeps, handleFixtureMessages } from '../batch/queue.ts';
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
  seed: 't20-fixture-files',
};
const files: readonly FixtureFile[] = [
  'fixture.pdf',
  'gt.json',
  'data.json',
  'check.json',
];
const print = vi.fn<Printer['print']>();
const check = vi.fn<Checker['check']>();
// Do not start the real Workflow: the test delivers its fixture messages itself.
const workflow = {
  create: vi.fn<Workflow<{ batchId: string }>['create']>(async options => ({
    id: options?.id ?? 'unexpected-workflow-id',
    pause: vi.fn<WorkflowInstance['pause']>(),
    resume: vi.fn<WorkflowInstance['resume']>(),
    terminate: vi.fn<WorkflowInstance['terminate']>(),
    restart: vi.fn<WorkflowInstance['restart']>(),
    delete: vi.fn<WorkflowInstance['delete']>(),
    status: vi.fn<WorkflowInstance['status']>(),
    sendEvent: vi.fn<WorkflowInstance['sendEvent']>(),
    subscribe: vi.fn<WorkflowInstance['subscribe']>(),
  })),
  get: vi.fn<Workflow<{ batchId: string }>['get']>(),
  createBatch: async () => {
    throw new Error('Unexpected Workflow.createBatch');
  },
  deleteBatch: vi.fn<Workflow<{ batchId: string }>['deleteBatch']>(),
} satisfies Workflow<{ batchId: string }>;

function db() {
  return drizzle(platform.env.DB, { schema });
}
function request(path: string, body?: unknown) {
  return fetch(
    new Request(`https://web.example.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...platform.env, BATCH_WORKFLOW: workflow },
  );
}
async function start(count = 1) {
  const response = await request('/api/batches', { ...input, count });
  expect(response.status).toBe(201);
  return batchSchema.parse(await response.json()).id;
}
async function complete(batchId: string, indexes: number[]) {
  const deps = {
    db: db(),
    files: platform.env.FILES,
    templates: fixtureTemplates,
    printers: { for: () => ({ print }), close: async () => {} },
    checker: { check },
    workflow: { get: async () => ({ sendEvent: async () => {} }) },
  } satisfies FixtureDeps;
  await handleFixtureMessages(
    indexes.map(
      index =>
        ({
          id: `${batchId}-${index}`,
          timestamp: new Date(),
          attempts: 1,
          body: { ...input, batchId, index } satisfies FixtureJob,
          ack: vi.fn(),
          retry: vi.fn(),
        }) satisfies Message<FixtureJob>,
    ),
    deps,
  );
  // Fail on broken setup rather than mislabeling a missing fixture as route RED.
  const rows = await db().select().from(schema.fixtures);
  for (const index of indexes) {
    expect(
      rows.find(row => row.batchId === batchId && row.index === index)?.status,
    ).toBe('completed');
  }
}
async function stored(batchId: string, index: number, file: FixtureFile) {
  const object = await platform.env.FILES.get(fixtureKey(batchId, index, file));
  if (!object) throw new Error(`Setup missing ${batchId}/${index}/${file}`);
  return new Uint8Array(await object.arrayBuffer());
}
async function expectError(response: Response, code: string) {
  expect(response.status).toBe(404);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}
async function expectDownload(
  batchId: string,
  index: number,
  file: FixtureFile,
) {
  const bytes = await stored(batchId, index, file);
  const response = await request(
    `/api/batches/${batchId}/fixtures/${index}/${file}`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(
    file === 'fixture.pdf' ? 'application/pdf' : 'application/json',
  );
  expect(response.headers.get('content-disposition')).toBe(
    `attachment; filename="${batchId}-${String(index).padStart(4, '0')}-${file}"`,
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
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
  print.mockImplementation(async job => ({
    pdf: new Uint8Array([37, 80, 68, 70, 45, 0, 255, job.source.index]),
    pageCount: 2,
    gt: gtSchema.parse({ ...gtExample, source: job.source }),
  }));
  check.mockReset();
  check.mockResolvedValue({ ok: true, differences: [] });
}, 60_000);
afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('downloads binary PDF bytes for the requested index with a padded attachment filename', async () => {
  // Regression: UTF-8 decoding corrupts PDF bytes, or the route always reads index 0.
  const id = await start(11);
  await complete(id, [0, 10]);
  for (const index of [0, 10]) await expectDownload(id, index, 'fixture.pdf');
});

test('downloads each stored JSON file without reserialization or mixing batches', async () => {
  // Regression: gt/data/check are confused, JSON whitespace is rewritten, or a batch id is ignored.
  const first = await start();
  const second = await start();
  await complete(first, [0]);
  await complete(second, [0]);
  for (const id of [second, first]) {
    for (const file of ['gt.json', 'data.json', 'check.json'] as const) {
      await expectDownload(id, 0, file);
    }
  }
});

test('returns batch_not_found for an unknown batch before validating its index', async () => {
  // Regression: a missing batch is hidden behind generic not_found or fixture_not_found.
  for (const index of ['0', 'x']) {
    await expectError(
      await request(`/api/batches/missing-batch/fixtures/${index}/gt.json`),
      'batch_not_found',
    );
  }
});

test('returns fixture_not_found for noncanonical or out-of-range indexes', async () => {
  // Regression: Number/parseInt aliases 01, 1.5, or 1e0 to a real fixture, or count is inclusive.
  const id = await start(2);
  await complete(id, [0, 1]);
  for (const index of [
    '01',
    '-1',
    'x',
    '1.5',
    '1e0',
    '2',
    '9007199254740992',
  ]) {
    await expectError(
      await request(`/api/batches/${id}/fixtures/${index}/gt.json`),
      'fixture_not_found',
    );
  }
});

test('returns file_not_found for unsupported filenames even when R2 contains them', async () => {
  // Regression: the route exposes arbitrary R2 objects instead of enforcing its file allowlist.
  const id = await start();
  await complete(id, [0]);
  for (const file of ['secret.txt', 'GT.json', 'fixture.png']) {
    await platform.env.FILES.put(`batches/${id}/0000/${file}`, 'private bytes');
    await expectError(
      await request(`/api/batches/${id}/fixtures/0/${file}`),
      'file_not_found',
    );
  }
});

test('returns file_not_found for pending fixtures even when their files exist in R2', async () => {
  // Regression: an R2 object alone makes unfinished fixture files downloadable.
  const id = await start();
  for (const file of files) {
    await platform.env.FILES.put(fixtureKey(id, 0, file), 'unfinished bytes');
    await expectError(
      await request(`/api/batches/${id}/fixtures/0/${file}`),
      'file_not_found',
    );
  }
});

test('returns file_not_found for failed fixtures even when their files exist in R2', async () => {
  // Regression: any fixture row, including a failed print with leftover files, authorizes downloads.
  const id = await start();
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 0,
    status: 'failed',
    attempts: 3,
    error: 'printer failed',
  });
  for (const file of files) {
    await platform.env.FILES.put(fixtureKey(id, 0, file), 'leftover bytes');
    await expectError(
      await request(`/api/batches/${id}/fixtures/0/${file}`),
      'file_not_found',
    );
  }
});

test('returns file_not_found when a completed fixture has no requested R2 object', async () => {
  // Regression: completed rows produce empty downloads or synthesized JSON when a stored file is absent.
  const id = await start();
  await complete(id, [0]);
  for (const file of files) {
    await platform.env.FILES.delete(fixtureKey(id, 0, file));
    await expectError(
      await request(`/api/batches/${id}/fixtures/0/${file}`),
      'file_not_found',
    );
  }
});
