import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  batchSchema,
  fixtureListSchema,
} from '@pdf-generator/contract';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { type FixtureFile, fixtureKey } from '../batch/fixture.ts';
import * as schema from '../db/schema.ts';
import { createFetchHandler } from '../worker.ts';

let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
const local = createLocalAccess();
const fetch = createFetchHandler({
  pages: async () => new Response('Unexpected pages', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
const files: FixtureFile[] = ['data.json', 'gt.json', 'fixture.pdf'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const db = () => drizzle(platform.env.DB, { schema });
const entryName = (index: number, file: FixtureFile) =>
  `${String(index).padStart(4, '0')}/${file}`;
const sha256 = (bytes: Uint8Array | undefined) => {
  if (!bytes) throw new Error('Missing ZIP entry');
  return createHash('sha256').update(bytes).digest('hex');
};

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
  const response = await request('/api/batches', 'POST', {
    templateId: 'fixture-report',
    templateVersion: 1,
    seed: 'slice4_zip',
    count,
  });
  expect(response.status).toBe(201);
  return batchSchema.parse(await response.json()).id;
}

async function finish(id: string, status: 'completed' | 'failed') {
  await db()
    .update(schema.batches)
    .set({ status, finishedAt: new Date('2026-01-02T03:04:05Z') })
    .where(eq(schema.batches.id, id));
}

// Whitespace, UTF-8 and binary bytes catch reserialization and decoding PDFs
// as text. The same index has identical bytes in each batch.
function contents(index: number, file: FixtureFile) {
  return file === 'fixture.pdf'
    ? new Uint8Array([37, 80, 68, 70, 45, index, 0, 128, 255, 10])
    : encoder.encode(
        `${JSON.stringify({ index, file, text: '臺灣' }, null, 2)}\n`,
      );
}

async function putFiles(id: string, index: number) {
  for (const file of files) {
    await platform.env.FILES.put(
      fixtureKey(id, index, file),
      contents(index, file),
    );
  }
}

async function complete(id: string, indexes: number[]) {
  // Insert out of order and keep statements below D1's 100-bind limit.
  for (const index of indexes) {
    await putFiles(id, index);
    await db().insert(schema.fixtures).values({
      batchId: id,
      index,
      status: 'completed',
      attempts: 1,
      pageCount: 1,
    });
  }
}

async function download(id: string) {
  const response = await request(`/api/batches/${id}/zip`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/zip');
  expect(response.headers.get('content-disposition')).toBe(
    `attachment; filename="${id}.zip"`,
  );
  expect(response.body).not.toBeNull();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const entries = unzipSync(bytes, {
    filter: entry => {
      expect(entry.compression, entry.name).toBe(0);
      return true;
    },
  });
  return { bytes, entries };
}

async function checkArchive(
  id: string,
  archive: Awaited<ReturnType<typeof download>>,
  completed: number[],
) {
  expect(Object.keys(archive.entries)).toEqual([
    'batch.json',
    'fixtures.json',
    ...completed.flatMap(index => files.map(file => entryName(index, file))),
  ]);
  const batchResponse = await request(`/api/batches/${id}`);
  const fixtureResponse = await request(`/api/batches/${id}/fixtures`);
  expect(batchResponse.status).toBe(200);
  expect(fixtureResponse.status).toBe(200);
  expect(
    batchSchema.parse(
      JSON.parse(decoder.decode(archive.entries['batch.json'])),
    ),
  ).toEqual(batchSchema.parse(await batchResponse.json()));
  expect(
    fixtureListSchema.parse(
      JSON.parse(decoder.decode(archive.entries['fixtures.json'])),
    ),
  ).toEqual(fixtureListSchema.parse(await fixtureResponse.json()));
  for (const index of completed) {
    for (const file of files) {
      const stored = await platform.env.FILES.get(fixtureKey(id, index, file));
      if (!stored) throw new Error('Missing test R2 object');
      expect(archive.entries[entryName(index, file)]).toEqual(
        new Uint8Array(await stored.arrayBuffer()),
      );
    }
  }
}

// Inspect ZIP central-directory DOS times independently of writer defaults.
function modificationTimes(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  expect(end).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    times.push(view.getUint32(offset + 12, true));
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  expect(count).toBeGreaterThan(0);
  return times;
}

beforeEach(async () => {
  platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
}, 60_000);

afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('downloads an ordered, lossless batch ZIP with stable bytes across downloads and identical fixture hashes in a rerun', async () => {
  const id = await start(12);
  await complete(id, [10, 2, 0, 11, 1, 9, 8, 7, 6, 5, 4, 3]);
  await finish(id, 'completed');
  const first = await download(id);
  const indexes = Array.from({ length: 12 }, (_, index) => index);
  await checkArchive(id, first, indexes);

  // DOS timestamps have two-second resolution; cross that boundary to catch
  // a writer accidentally using the download's wall-clock time.
  await new Promise(resolve => setTimeout(resolve, 2_100));
  const second = await download(id);
  expect(second.bytes).toEqual(first.bytes);
  const times = modificationTimes(first.bytes);
  expect(new Set(times).size).toBe(1);
  expect(modificationTimes(second.bytes)).toEqual(times);

  const rerunResponse = await request(`/api/batches/${id}/rerun`, 'POST');
  expect(rerunResponse.status).toBe(201);
  const rerun = batchSchema.parse(await rerunResponse.json());
  expect(rerun.id).not.toBe(id);
  await complete(rerun.id, indexes.toReversed());
  await finish(rerun.id, 'completed');
  const replay = await download(rerun.id);
  await checkArchive(rerun.id, replay, indexes);
  expect(modificationTimes(replay.bytes)).toEqual(times);
  for (const index of indexes) {
    for (const file of files) {
      const name = entryName(index, file);
      expect(sha256(replay.entries[name])).toBe(sha256(first.entries[name]));
    }
  }
  expect(replay.entries['batch.json']).not.toEqual(first.entries['batch.json']);
  expect(replay.entries['fixtures.json']).not.toEqual(
    first.entries['fixtures.json'],
  );
}, 30_000);

test('downloads a failed batch with completed files only, preserving failed and pending indexes in fixtures.json', async () => {
  const id = await start(5);
  await complete(id, [4, 0, 2]);
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 1,
    status: 'failed',
    attempts: 3,
    error: 'invalid_layout: overflowing page',
  });
  // Orphaned files from failed and pending attempts must not leak into ZIPs.
  await putFiles(id, 1);
  await putFiles(id, 3);
  await finish(id, 'failed');
  const archive = await download(id);
  await checkArchive(id, archive, [0, 2, 4]);
  expect(JSON.parse(decoder.decode(archive.entries['fixtures.json']))).toEqual({
    batchId: id,
    fixtures: [
      { index: 0, status: 'completed' },
      { index: 1, status: 'failed', error: 'invalid_layout: overflowing page' },
      { index: 2, status: 'completed' },
      { index: 3, status: 'pending' },
      { index: 4, status: 'completed' },
    ],
  });
});

test.each(['queued', 'running'] as const)(
  'refuses a %s batch ZIP instead of exposing a misleading partial download',
  async status => {
    const id = await start(2);
    await complete(id, [0]);
    await db()
      .update(schema.batches)
      .set({ status })
      .where(eq(schema.batches.id, id));
    const response = await request(`/api/batches/${id}/zip`);
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      'batch_not_finished',
    );
  },
);

test('reports batch_not_found for an unknown ZIP instead of a generic missing route or an empty archive', async () => {
  const response = await request('/api/batches/missing-batch/zip');
  expect(response.status).toBe(404);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
    'batch_not_found',
  );
});
