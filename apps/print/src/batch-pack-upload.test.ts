// A batch's pack upload under failures R2 can't be told to produce: a file
// write that fails, two uploads that overlap, a delete that fails. The bucket
// is in memory; every check goes through what a print or the sweep sees, not
// through the key layout.
import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import {
  deleteBatchPack,
  PackNotUploadedError,
  publishBatchFiles,
  sweepBatchPacks,
  uploadBatchPack,
} from './pack-files.ts';

const batch = '5b3e9d10-7c2a-4e6f-9a1b-2c3d4e5f6a01';
const origin = 'https://print.test';
const template = 'templates/report.hbs';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const files = {
  [template]: b64('<p data-gt="text">{{name}}</p>'),
  'styles/report.css': b64('p { color: black; }'),
  'assets/logo.svg': b64('<svg xmlns="http://www.w3.org/2000/svg"/>'),
};
const hour = 3_600_000;

type Value = Uint8Array | string;

/**
 * An R2 bucket in memory: objects keep the time they were written (from
 * `clock`), and `list` answers two keys a page, as R2 pages (at most 1000).
 */
function memoryBucket(clock = { now: Date.UTC(2026, 10, 4, 12) }) {
  const objects = new Map<
    string,
    { value: Value; uploaded: Date; customMetadata?: Record<string, string> }
  >();
  const text = (value: Value) =>
    typeof value === 'string' ? value : new TextDecoder().decode(value);
  const bucket = {
    clock,
    keys: () => [...objects.keys()].sort(),
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      // What was stored when get was called, however long the caller waits.
      return {
        key,
        uploaded: object.uploaded,
        customMetadata: object.customMetadata ?? {},
        json: async () => JSON.parse(text(object.value)) as unknown,
        text: async () => text(object.value),
        arrayBuffer: async () => new TextEncoder().encode(text(object.value)),
      };
    },
    async put(
      key: string,
      value: Value,
      options?: { customMetadata?: Record<string, string> },
    ) {
      objects.set(key, {
        value,
        uploaded: new Date(clock.now),
        ...(options?.customMetadata
          ? { customMetadata: options.customMetadata }
          : {}),
      });
      return { key };
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({
      prefix = '',
      cursor,
    }: {
      prefix?: string;
      cursor?: string;
    } = {}) {
      const matching = [...objects.keys()]
        .filter(key => key.startsWith(prefix))
        .sort();
      const from = cursor ? Number(cursor) : 0;
      const page = matching.slice(from, from + 2).map(key => ({
        key,
        uploaded: objects.get(key)?.uploaded ?? new Date(0),
      }));
      const next = from + 2;
      return next < matching.length
        ? { objects: page, truncated: true, cursor: String(next) }
        : { objects: page, truncated: false };
    },
  };
  return bucket;
}

type Bucket = ReturnType<typeof memoryBucket>;

/** `bucket`, except that writing the pack file `path` fails. */
function failingWrite(bucket: Bucket, path: string): Bucket {
  return {
    ...bucket,
    put: async (key, value, options) => {
      if (key.endsWith(`/${path}`)) throw new Error(`writing ${path} failed`);
      return bucket.put(key, value, options);
    },
  };
}

const upload = (bucket: Bucket) =>
  uploadBatchPack(bucket as never, batch, files);

/** A print by reference of the pack `digest`: it publishes its document. */
const print = (bucket: Bucket, digest: string) =>
  publishBatchFiles(bucket, origin, '<p data-gt="text">x</p>', {
    template,
    batch,
    digest,
  });

// Regression (T07-5 review): an upload that read "not uploaded" before an
// overlapping upload of the same content completed, then failed a file write,
// turned the complete upload back to incomplete: every print answered 409
// pack_not_uploaded until the batch uploaded again.
test('an overlapping upload that fails a file write leaves the completed upload complete', async () => {
  const bucket = memoryBucket();
  // The late upload's first read is answered with what it read, but only
  // once the other upload has completed.
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  let reads = 0;
  const late: Bucket = {
    ...failingWrite(bucket, 'styles/report.css'),
    get: async key => {
      const read = bucket.get(key);
      if (reads++ === 0) await held;
      return read;
    },
  };
  const failing = upload(late);
  failing.catch(() => undefined);
  const digest = await upload(bucket);
  release();
  await expect(failing).rejects.toThrow('writing styles/report.css failed');

  const published = await print(bucket, digest);
  expect(
    published.serves(`${origin}/batch/${batch}/${digest}/styles/report.css`),
  ).toBe(true);
  // A later upload of the same content finds it complete and writes nothing.
  let writes = 0;
  const counting: Bucket = {
    ...bucket,
    put: async (key, value, options) => {
      writes++;
      return bucket.put(key, value, options);
    },
  };
  expect(await upload(counting)).toBe(digest);
  expect(writes).toBe(0);
});

// Regression guard: completion must not come before every file is written,
// or a print finds a complete pack with a file missing.
test('a lone upload that fails a file write leaves the pack unprintable until an upload completes', async () => {
  const bucket = memoryBucket();
  // The digest a complete upload of the same files answers.
  const digest = await upload(memoryBucket());
  await expect(upload(failingWrite(bucket, 'assets/logo.svg'))).rejects.toThrow(
    'writing assets/logo.svg failed',
  );
  await expect(print(bucket, digest)).rejects.toBeInstanceOf(
    PackNotUploadedError,
  );
  // The next upload finishes it.
  expect(await upload(bucket)).toBe(digest);
  await expect(print(bucket, digest)).resolves.toMatchObject({
    documentUrl: expect.stringContaining(`/batch/${batch}/${digest}/`),
  });
});

// Regression guard: whatever records an upload's completion, the sweep must
// delete it with the files, or a swept pack still prints with files gone.
test('the sweep leaves nothing of an expired upload, and its prints refuse', async () => {
  const bucket = memoryBucket();
  const digest = await upload(bucket);
  bucket.clock.now += 26 * hour;
  await sweepBatchPacks(bucket, bucket.clock.now);
  expect(bucket.keys()).toEqual([]);
  await expect(print(bucket, digest)).rejects.toBeInstanceOf(
    PackNotUploadedError,
  );
});

/** `bucket`, except that a delete including the pack file `path` fails. */
function failingDelete(bucket: Bucket, path: string): Bucket {
  return {
    ...bucket,
    delete: async keys => {
      if ([keys].flat().some(key => key.endsWith(`/${path}`))) {
        throw new Error(`deleting ${path} failed`);
      }
      return bucket.delete(keys);
    },
  };
}

// Regression (T07-5 review): ending a batch deleted its upload index before
// its files, so files whose delete failed were never found by the sweep.
test('files a failed batch end could not delete are deleted by a later sweep', async () => {
  const bucket = memoryBucket();
  const digest = await upload(bucket);
  await expect(
    deleteBatchPack(failingDelete(bucket, 'styles/report.css'), batch),
  ).rejects.toThrow('deleting styles/report.css failed');
  // The batch has ended: its prints refuse, though files are left.
  await expect(print(bucket, digest)).rejects.toBeInstanceOf(
    PackNotUploadedError,
  );
  bucket.clock.now += 26 * hour;
  await sweepBatchPacks(bucket, bucket.clock.now);
  expect(bucket.keys()).toEqual([]);
});

test('files a failed sweep could not delete are deleted by the next sweep', async () => {
  const bucket = memoryBucket();
  const digest = await upload(bucket);
  bucket.clock.now += 26 * hour;
  // Never throws: it runs in the background after an upload.
  await sweepBatchPacks(
    failingDelete(bucket, 'styles/report.css'),
    bucket.clock.now,
  );
  await expect(print(bucket, digest)).rejects.toBeInstanceOf(
    PackNotUploadedError,
  );
  await sweepBatchPacks(bucket, bucket.clock.now);
  expect(bucket.keys()).toEqual([]);
});
