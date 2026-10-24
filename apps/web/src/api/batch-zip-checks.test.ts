import { fileURLToPath } from 'node:url';
import { batchSchema, fixtureListSchema } from '@pdf-generator/contract';
import type { Difference, SelfCheckReport } from '@pdf-generator/self-check';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { type FixtureFile, fixtureKey } from '../batch/fixture.ts';
import * as schema from '../db/schema.ts';
import { storeFixturePack } from '../templates/fixture-pack.ts';
import { createFetchHandler } from '../worker.ts';

let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
const local = createLocalAccess();
const fetch = createFetchHandler({
  pages: async () => new Response('Unexpected pages', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const checkedFiles: readonly FixtureFile[] = [
  'data.json',
  'gt.json',
  'fixture.pdf',
  'check.json',
];
const storedFiles = [
  'data.json',
  'gt.json',
  'fixture.pdf',
] as const satisfies readonly FixtureFile[];
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
const db = () => drizzle(platform.env.DB, { schema });
const entryName = (index: number, file: FixtureFile) =>
  `${String(index).padStart(4, '0')}/${file}`;

// Spaces before colons, so the bytes are not JSON.stringify of the report
// (compact or pretty). A zip that rewrites check.json fails a byte compare.
function irregularJson(report: SelfCheckReport): Uint8Array {
  return encoder.encode(`${JSON.stringify(report).replaceAll('":', '" :')}\n`);
}

const passingCheck = irregularJson(passingReport);
const failingCheck = irregularJson(mismatchReport);
const orphanCheck = encoder.encode('orphan check.json 臺灣\n');

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
    seed: 't16-1-zip-checks',
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

function payload(index: number, file: 'data.json' | 'gt.json' | 'fixture.pdf') {
  return file === 'fixture.pdf'
    ? new Uint8Array([37, 80, 68, 70, 45, index, 0, 128, 255, 10])
    : encoder.encode(
        `${JSON.stringify({ index, file, text: '臺灣' }, null, 2)}\n`,
      );
}

async function putFiles(
  id: string,
  index: number,
  files: readonly FixtureFile[],
  check?: Uint8Array,
) {
  for (const file of files) {
    const bytes = file === 'check.json' ? check : payload(index, file);
    if (!bytes) throw new Error(`missing bytes for ${index}/${file}`);
    await platform.env.FILES.put(fixtureKey(id, index, file), bytes);
  }
}

function expectIrregularReport(bytes: Uint8Array, report: SelfCheckReport) {
  const text = decoder.decode(bytes);
  expect(JSON.parse(text)).toEqual(report);
  expect(text).not.toBe(JSON.stringify(report));
  expect(text).not.toBe(`${JSON.stringify(report, null, 2)}\n`);
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
  return { bytes, entries: unzipSync(bytes) };
}

async function expectFixtureList(
  id: string,
  entries: Record<string, Uint8Array>,
  expected: unknown,
) {
  const response = await request(`/api/batches/${id}/fixtures`);
  expect(response.status).toBe(200);
  const listed = fixtureListSchema.parse(await response.json());
  const packed = fixtureListSchema.parse(
    JSON.parse(decoder.decode(entries['fixtures.json'] ?? new Uint8Array())),
  );
  expect(packed).toEqual(listed);
  expect(packed).toEqual(expected);
}

// Central-directory DOS times, so a check.json stamped at download time is
// visible without waiting out the two-second DOS resolution.
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
  await storeFixturePack(platform.env);
}, 60_000);

afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('downloads an ordered zip whose completed fixtures include stored check.json, including a failed check, and repeats the same bytes', async () => {
  // Regression: the zip drops check.json, puts it anywhere but after
  // fixture.pdf, rewrites the stored bytes (a failed check's differences
  // included), strips check off fixtures.json, or is not byte-stable.
  expectIrregularReport(passingCheck, passingReport);
  expectIrregularReport(failingCheck, mismatchReport);
  const count = 11;
  const id = await start(count);
  await putFiles(id, 10, checkedFiles, failingCheck);
  await putFiles(id, 0, checkedFiles, passingCheck);
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 10,
    status: 'completed',
    attempts: 1,
    pageCount: 2,
    checkPassed: false,
    checkDifferences: mismatchReport.differences.length,
  });
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 0,
    status: 'completed',
    attempts: 1,
    pageCount: 1,
    checkPassed: true,
    checkDifferences: 0,
  });
  await finish(id, 'completed');

  const first = await download(id);
  await expectFixtureList(id, first.entries, {
    batchId: id,
    fixtures: Array.from({ length: count }, (_, index) => {
      if (index === 0) {
        return {
          index,
          status: 'completed' as const,
          check: { passed: true, differences: 0 },
        };
      }
      if (index === 10) {
        return {
          index,
          status: 'completed' as const,
          check: {
            passed: false,
            differences: mismatchReport.differences.length,
          },
        };
      }
      return { index, status: 'pending' as const };
    }),
  });
  expect(Object.keys(first.entries)).toEqual([
    'batch.json',
    'fixtures.json',
    ...[0, 10].flatMap(index =>
      checkedFiles.map(file => entryName(index, file)),
    ),
  ]);
  const stored = new Map<number, Uint8Array>([
    [0, passingCheck],
    [10, failingCheck],
  ]);
  for (const [index, check] of stored) {
    for (const file of checkedFiles) {
      expect(first.entries[entryName(index, file)]).toEqual(
        file === 'check.json' ? check : payload(index, file),
      );
    }
  }

  const second = await download(id);
  expect(second.bytes).toEqual(first.bytes);
  const times = modificationTimes(first.bytes);
  expect(new Set(times).size).toBe(1);
  expect(modificationTimes(second.bytes)).toEqual(times);
}, 30_000);

test('zips a pre-ticket fixture that has no check.json, and leaves failed and pending check objects out', async () => {
  // Regression: a completed row with null check columns and no check.json
  // fails the download or gains an entry. A failed or pending index's
  // orphaned check.json is packed. The completed sibling that has one is
  // still included, or this would pass by omitting every check.json.
  const id = await start(4);
  await putFiles(id, 2, checkedFiles, orphanCheck);
  await putFiles(id, 3, checkedFiles, orphanCheck);
  await putFiles(id, 1, storedFiles);
  await putFiles(id, 0, checkedFiles, failingCheck);
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 2,
    status: 'failed',
    attempts: 3,
    error: 'invalid_layout: overflowing page',
  });
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 1,
    status: 'completed',
    attempts: 1,
    pageCount: 1,
  });
  await db().insert(schema.fixtures).values({
    batchId: id,
    index: 0,
    status: 'completed',
    attempts: 1,
    pageCount: 2,
    checkPassed: false,
    checkDifferences: mismatchReport.differences.length,
  });
  await finish(id, 'failed');

  const archive = await download(id);
  await expectFixtureList(id, archive.entries, {
    batchId: id,
    fixtures: [
      {
        index: 0,
        status: 'completed',
        check: {
          passed: false,
          differences: mismatchReport.differences.length,
        },
      },
      { index: 1, status: 'completed' },
      {
        index: 2,
        status: 'failed',
        error: 'invalid_layout: overflowing page',
      },
      { index: 3, status: 'pending' },
    ],
  });
  expect(Object.keys(archive.entries)).toEqual([
    'batch.json',
    'fixtures.json',
    ...checkedFiles.map(file => entryName(0, file)),
    ...storedFiles.map(file => entryName(1, file)),
  ]);
  expect(archive.entries[entryName(0, 'check.json')]).toEqual(failingCheck);
  for (const file of storedFiles) {
    expect(archive.entries[entryName(1, file)]).toEqual(payload(1, file));
  }
  for (const index of [1, 2, 3]) {
    expect(archive.entries[entryName(index, 'check.json')]).toBeUndefined();
  }
}, 30_000);
