import { crc32, inflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { assemble, thirteenBlocks } from './deflate-fixtures.test-support.ts';
import { unzipWithinLimits } from './limits.ts';

test('refuses 1,000 files before scanning their 13,000 dynamic blocks within 200 ms', () => {
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
  // Warm the directory parsing and inflation paths before timing the refusal.
  unzipWithinLimits(
    assemble(parts.slice(0, 1), new Map([['asset-0.png', data.length]])),
  );
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const result = unzipWithinLimits(zip);
    times.push(performance.now() - start);
    expect(result).toMatchObject({
      issues: [
        {
          code: 'pack-too-many-files',
          message: expect.stringContaining('1000'),
        },
      ],
    });
  }
  console.info(`1,000-file timings (ms): ${times.join(', ')}`);
  expect([...times].sort((a, b) => a - b)[1]).toBeLessThan(200);
}, 30_000);
