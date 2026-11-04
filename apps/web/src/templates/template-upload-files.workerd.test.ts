import { crc32, inflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { assemble, thirteenBlocks } from './deflate-fixtures.test-support.ts';
import { unzipWithinLimits } from './limits.ts';
import { countWork } from './upload-work.test-support.ts';

test('refuses 1,000 files before scanning or inflating any of their 13,000 dynamic blocks', () => {
  const { stream, data } = thirteenBlocks();
  expect(inflateRawSync(stream).length).toBe(data.length);
  expect(data.length * 1000).toBeLessThanOrEqual(20 * 1024 * 1024);
  const parts = Array.from({ length: 1000 }, (_, i) => ({
    name: `asset-${i}.png`,
    stream,
    method: 8 as const,
    crc: crc32(data),
  }));
  const zip = assemble(
    parts,
    new Map(parts.map(part => [part.name, data.length])),
  );
  expect(zip.length).toBeLessThan(10 * 1024 * 1024);
  const { result, work } = countWork(() => unzipWithinLimits(zip));
  expect(result).toMatchObject({
    issues: [
      {
        code: 'pack-too-many-files',
        message: expect.stringContaining('1000'),
      },
    ],
  });
  // Timing this refusal (200 ms) could fail under load (T09-6). The files
  // are counted from the zip's directory, so none of their streams is
  // copied, scanned or inflated: refusing them costs nothing per block.
  expect(work).toEqual({
    tables: 0,
    inflaters: 0,
    pushed: 0,
    inflated: 0,
    concatenated: 0,
    sliced: 0,
  });
});
