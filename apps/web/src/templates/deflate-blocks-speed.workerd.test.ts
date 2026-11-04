import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { tables } from './deflate-blocks.ts';
import { assemble, longStream } from './deflate-fixtures.test-support.ts';
import { unzipWithinLimits } from './limits.ts';

const hash = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
/**
 * Table reads decoding a dynamic block's header may take beyond its
 * literals: at most 316 code lengths and the end-of-block code, each read in
 * one or two.
 */
const headerReads = 1024;
test.each([10, 15])(
  'accepts a nearly 10 MiB honest %i-bit literal zip reading at most two table entries per literal',
  width => {
    const { stream, data } = longStream(
      width,
      Math.floor(((10 * 1024 * 1024 - 16384) * 8) / width),
    );
    const zip = assemble(
      [{ name: 'x.png', stream, method: 8, crc: crc32(data) }],
      new Map([['x.png', data.length]]),
    );
    expect(zip.length).toBeGreaterThan(9.9 * 1024 * 1024);
    expect(zip.length).toBeLessThan(10 * 1024 * 1024);
    // The public limit API intentionally empties binary assets; independently
    // verify this honest stream rather than comparing that empty placeholder.
    const inflated = new Uint8Array(inflateRawSync(stream));
    expect(inflated.length).toBe(data.length);
    expect(hash(inflated)).toBe(hash(data));
    // Timing the upload, even against T15-1's frozen scan in the same run,
    // failed under load (1040 ms against 882 ms, PR #116), so count the work
    // instead: every read of a decoding table. Every literal here is a 10- or
    // 15-bit code, which the two-level tables decode in two reads; T15-1's
    // scan took a step per bit, and a second pass over the stream would
    // double the count.
    let reads = 0;
    const create = tables.create;
    tables.create = size =>
      new Proxy(create(size), {
        get(table, key) {
          reads++;
          return Reflect.get(table, key);
        },
        set: (table, key, value) => Reflect.set(table, key, value),
      });
    let result: ReturnType<typeof unzipWithinLimits>;
    try {
      result = unzipWithinLimits(zip);
    } finally {
      tables.create = create;
    }
    expect(result).not.toHaveProperty('issues');
    if (!('files' in result)) throw new Error(JSON.stringify(result));
    expect(result.files['x.png']?.length).toBe(0);
    console.info(
      `${width}-bit literals: ${data.length}, table reads: ${reads}`,
    );
    // At least one per literal: the upload did scan the stream.
    expect(reads).toBeGreaterThanOrEqual(data.length);
    expect(reads).toBeLessThanOrEqual(2 * data.length + headerReads);
  },
  // A hang guard, not a speed bound: reading the tables through the Proxy
  // took 4-11 s a case on the VM, idle to every CPU busy.
  60_000,
);
