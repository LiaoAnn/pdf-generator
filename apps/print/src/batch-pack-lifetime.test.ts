// A batch's uploaded pack lives until the batch ends (DELETE /batch/<id>),
// and at most a day longer when nobody ends it (the sweep).
import { URL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';
import { sweepBatchPacks } from './pack-files.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';
import { readValidPack, type ValidPack } from './valid-pack.fixture.ts';

const token = 'batch-pack-lifetime-local-test';
const batch = '7a1d3c40-2b6e-4f1a-8c3d-9e0f1a2b3c01';
const otherBatch = '7a1d3c40-2b6e-4f1a-8c3d-9e0f1a2b3c02';
const auth = { authorization: `Bearer ${token}` };
let worker: PrintWorker;
let pack: ValidPack;
let origin: string;

type Answer = Awaited<ReturnType<PrintWorker['fetch']>>;

beforeAll(async () => {
  pack = await readValidPack();
  worker = await startPrintWorker(token);
  origin = (await worker.url).origin;
});

afterAll(async () => {
  await worker?.dispose();
});

async function upload(id: string): Promise<string> {
  const response = await worker.fetch(new URL(`/batch/${id}/pack`, origin), {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ files: pack.files }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { digest: string }).digest;
}

const end = (id: string, headers: Record<string, string> = auth) =>
  worker.fetch(new URL(`/batch/${id}`, origin), { method: 'DELETE', headers });

const print = (id: string, digest: string) =>
  worker.fetch(new URL('/print', origin), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      html: pack.html(),
      page: pack.page,
      pack: { template: pack.template, batch: id, digest },
    }),
  });

const css = (id: string, digest: string) =>
  worker.fetch(`${origin}/batch/${id}/${digest}/styles/report.css`);

async function code(response: Answer) {
  return apiErrorSchema.parse(await response.json()).error.code;
}

// Regression: a pack copy left after its batch keeps serving its files and
// fills the bucket; ending one batch must not end another's.
test('ending a batch deletes its pack and leaves other batches printing', async () => {
  const digest = await upload(batch);
  expect(await upload(otherBatch)).toBe(digest);
  expect((await print(batch, digest)).status).toBe(200);

  const unauthorized = await end(batch, {});
  expect(unauthorized.status).toBe(401);
  expect((await css(batch, digest)).status).toBe(200);

  expect((await end(batch)).status).toBe(204);
  expect((await css(batch, digest)).status).toBe(404);
  const refused = await print(batch, digest);
  expect(refused.status).toBe(409);
  expect(await code(refused)).toBe('pack_not_uploaded');

  expect((await css(otherBatch, digest)).status).toBe(200);
  expect((await print(otherBatch, digest)).status).toBe(200);
  // Ending a batch twice, or one that never uploaded, is not an error.
  expect((await end(batch)).status).toBe(204);
  expect((await end('7a1d3c40-2b6e-4f1a-8c3d-9e0f1a2b3c09')).status).toBe(204);
  expect((await end('not-a-batch')).status).toBe(400);
});

// The bucket as the sweep sees it: listed a page of `pageSize` keys at a
// time, as R2 does (at most 1000), so a sweep that reads one page misses keys.
function bucket(objects: Record<string, number>, pageSize = 2) {
  const keys = new Map(
    Object.entries(objects).map(([key, uploaded]) => [key, new Date(uploaded)]),
  );
  const store: Parameters<typeof sweepBatchPacks>[0] = {
    async list({ prefix = '', cursor } = {}) {
      const matching = [...keys.keys()].filter(key => key.startsWith(prefix));
      matching.sort();
      const from = cursor ? Number(cursor) : 0;
      const page = matching.slice(from, from + pageSize);
      const next = from + pageSize;
      const listed = page.map(key => ({
        key,
        uploaded: keys.get(key) ?? new Date(0),
      }));
      return next < matching.length
        ? { objects: listed, truncated: true, cursor: String(next) }
        : { objects: listed, truncated: false };
    },
    async delete(names: string | string[]) {
      for (const name of [names].flat()) keys.delete(name);
    },
  };
  return { store, keys: () => [...keys.keys()].sort() };
}

const hour = 3_600_000;
const old = '11111111-1111-4111-8111-111111111111';
const dayOld = '22222222-2222-4222-8222-222222222222';
const fresh = '33333333-3333-4333-8333-333333333333';
const digest = 'a'.repeat(64);

// Regression: a batch whose end never reached the print Worker (its web
// isolate died) keeps its pack forever; a sweep by any other age deletes a
// batch that may still run (a batch gets 24 hours).
test('the sweep deletes batches uploaded more than 25 hours ago, and only those', async () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const keep = [
    `${dayOld}/templates/report.hbs`,
    `batch-index/${dayOld}/${digest}`,
    `batch/${dayOld}/${digest}/pack/assets/report.woff2`,
    `batch-index/${fresh}/${digest}`,
    `batch/${fresh}/${digest}/pack/styles/report.css`,
    `batch/${fresh}/${digest}/print/44444444-4444-4444-8444-444444444444`,
  ];
  const { store, keys } = bucket({
    [`batch-index/${old}/${digest}`]: now - 26 * hour,
    [`batch-index/${old}/${'b'.repeat(64)}`]: now - 30 * hour,
    [`batch/${old}/${digest}/pack/assets/report.woff2`]: now - 26 * hour,
    [`batch/${old}/${digest}/pack/styles/report.css`]: now - 26 * hour,
    [`batch/${old}/${digest}/pack/assets/logo.svg`]: now - 26 * hour,
    [`batch/${old}/${digest}/print/55555555-5555-4555-8555-555555555555`]:
      now - 2 * hour,
    // An inline print's files (/pack/<id>/…) are not the sweep's.
    [`${dayOld}/templates/report.hbs`]: now - 40 * hour,
    [`batch-index/${dayOld}/${digest}`]: now - 24 * hour,
    [`batch/${dayOld}/${digest}/pack/assets/report.woff2`]: now - 24 * hour,
    [`batch-index/${fresh}/${digest}`]: now - hour,
    [`batch/${fresh}/${digest}/pack/styles/report.css`]: now - 30 * hour,
    [`batch/${fresh}/${digest}/print/44444444-4444-4444-8444-444444444444`]:
      now - hour,
  });
  await sweepBatchPacks(store, now);
  expect(keys()).toEqual(keep.sort());
});
