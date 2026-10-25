import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { scanDeflateReference } from './deflate-blocks-reference.ts';
import { assemble, longStream } from './deflate-fixtures.test-support.ts';
import { unzipWithinLimits } from './limits.ts';

const hash = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const median = (times: number[]) => [...times].sort((a, b) => a - b)[1] ?? 0;
test.each([10, 15])(
  'accepts a nearly 10 MiB honest %i-bit literal zip in under 0.8 of the reference scan time',
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
    scanDeflateReference(warm.stream, warm.data.length);
    // Absolute bounds fail on slower machines (a GitHub runner took 310 ms
    // where this VM takes 240 ms), so time T15-1's frozen scan on the same
    // stream in the same run and compare with it. Rounds interleave the two
    // so a slow spell of the machine slows both.
    const times: number[] = [];
    const reference: number[] = [];
    for (let i = 0; i < 3; i++) {
      let start = performance.now();
      const result = unzipWithinLimits(zip);
      times.push(performance.now() - start);
      expect(result).not.toHaveProperty('issues');
      if (!('files' in result)) throw new Error(JSON.stringify(result));
      expect(result.files['x.png']?.length).toBe(0);
      start = performance.now();
      const scan = scanDeflateReference(stream, data.length);
      reference.push(performance.now() - start);
      expect(scan).toMatchObject({ ok: true, output: data.length });
    }
    console.info(
      `${width}-bit literal timings (ms): ${times.join(', ')}; reference scan: ${reference.join(', ')}`,
    );
    // Medians tolerate one scheduling outlier in either series. Here the
    // whole unzip takes 0.38-0.54 of the reference scan, and T15-1's scan in
    // its place took 1.25, so 0.8 leaves room both ways.
    expect(median(times)).toBeLessThan(median(reference) * 0.8);
  },
  30_000,
);
