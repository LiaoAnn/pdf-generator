import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { assemble, longStream } from './deflate-fixtures.test-support.ts';
import { unzipWithinLimits } from './limits.ts';

const hash = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
test.each([10, 15])(
  'accepts a nearly 10 MiB honest %i-bit literal zip within 300 ms',
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
    const warm = longStream(width, 4096);
    unzipWithinLimits(
      assemble(
        [
          {
            name: 'warm.png',
            stream: warm.stream,
            method: 8,
            crc: crc32(warm.data),
          },
        ],
        new Map([['warm.png', warm.data.length]]),
      ),
    );
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const result = unzipWithinLimits(zip);
      times.push(performance.now() - start);
      expect(result).not.toHaveProperty('issues');
      if (!('files' in result)) throw new Error(JSON.stringify(result));
      expect(result.files['x.png']?.length).toBe(0);
    }
    console.info(`${width}-bit literal timings (ms): ${times.join(', ')}`);
    // The median tolerates one scheduling outlier, while catching the current
    // 546–680 ms scan. The prior 109–174 ms implementation has ample margin.
    expect([...times].sort((a, b) => a - b)[1]).toBeLessThan(300);
  },
  30_000,
);
