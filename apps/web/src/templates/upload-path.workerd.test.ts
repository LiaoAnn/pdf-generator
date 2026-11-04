import { crc32, deflateRawSync } from 'node:zlib';
import { strToU8 } from 'fflate';
import { expect, test } from 'vitest';
import { scanDeflate, tables } from './deflate-blocks.ts';
import { assemble, longStream } from './deflate-fixtures.test-support.ts';
import { unzipWithinLimits } from './limits.ts';
import { steps } from './unzip.ts';

// The upload used to be timed whole against T15-1's scan, which failed under
// load (PR #116); T09-4 replaced that with counting the scan's table reads,
// which no longer sees the rest of the path. So count the rest too, from
// first principles: each deflated entry is scanned once, inflated once, and
// copied once, and so are its contents.

/** One zip entry: its name, its contents, and how the zip stores them. */
type Entry = {
  name: string;
  data: Uint8Array;
  /** Deflate data, or none for a stored entry. */
  deflated?: Uint8Array;
  /** Bytes after the final deflate block, part of the entry in the zip. */
  padding?: number;
};

/** Pseudo-random bytes from a fixed seed, `mask` keeping them compressible. */
function noise(length: number, seed: number, mask: number) {
  const bytes = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes[i] = (x >>> 24) & mask;
  }
  return bytes;
}

function words(count: number, seed: number) {
  const vocabulary = [
    '臺北市',
    '報表',
    'PDF',
    'fixture',
    '金額',
    '2026',
    '統一編號',
  ];
  const picks = noise(count, seed, 0xff);
  return strToU8(
    Array.from(
      picks,
      (pick, i) => `${vocabulary[pick % 7]}${i % 13 ? ' ' : '\n'}`,
    ).join(''),
  );
}

const deflate = (data: Uint8Array) => new Uint8Array(deflateRawSync(data));

function zipOf(entries: Entry[]) {
  return assemble(
    entries.map(entry => {
      const stream = entry.deflated
        ? new Uint8Array(entry.deflated.length + (entry.padding ?? 0))
        : entry.data;
      if (entry.deflated) stream.set(entry.deflated);
      return {
        name: entry.name,
        stream,
        method: entry.deflated ? 8 : 0,
        crc: crc32(entry.data),
      };
    }),
    new Map(entries.map(entry => [entry.name, entry.data.length])),
  );
}

const ignored = (name: string) =>
  name.endsWith('/') || name.startsWith('__MACOSX/');

/** The work the upload of `zip` does, counted at the seams it runs through. */
function count(zip: Uint8Array) {
  const work = { tables: 0, inflaters: 0, pushed: 0, inflated: 0 };
  const create = tables.create;
  const inflater = steps.inflater;
  tables.create = size => {
    work.tables++;
    return create(size);
  };
  steps.inflater = ondata => {
    work.inflaters++;
    const inflate = inflater((data, final) => {
      work.inflated += data.length;
      ondata(data, final);
    });
    const push = inflate.push.bind(inflate);
    inflate.push = (chunk, final) => {
      work.pushed += chunk.length;
      push(chunk, final);
    };
    return inflate;
  };
  try {
    return { result: unzipWithinLimits(zip), work };
  } finally {
    tables.create = create;
    steps.inflater = inflater;
  }
}

const tenBit = () => {
  const { stream, data } = longStream(
    10,
    Math.floor(((10 * 1024 * 1024 - 16384) * 8) / 10),
  );
  return [{ name: 'x.png', data, deflated: stream }];
};

const pack = () => {
  const text = words(8000, 7);
  const image = noise(4 * 1024 * 1024, 11, 0x0f);
  const padded = noise(300 * 1024, 13, 0x07);
  return [
    { name: 'pack/', data: new Uint8Array() },
    { name: '__MACOSX/pack/._a.txt', data: text, deflated: deflate(text) },
    { name: 'pack/a.txt', data: text, deflated: deflate(text) },
    { name: 'pack/b.png', data: image, deflated: deflate(image) },
    { name: 'pack/c.png', data: noise(100 * 1024, 17, 0xff) },
    {
      name: 'pack/d.png',
      data: padded,
      deflated: deflate(padded),
      padding: 64 * 1024,
    },
  ];
};

test.each([
  ['a nearly 10 MiB 10-bit literal entry', tenBit],
  ['a pack of deflated, stored, padded and ignored entries', pack],
])('uploading %s inflates each deflated entry once', (_, entries) => {
  const all: Entry[] = entries();
  const zip = zipOf(all);
  const { result, work } = count(zip);
  if (!('files' in result)) throw new Error(JSON.stringify(result));
  const files = all.filter(entry => !ignored(entry.name));
  expect(Object.keys(result.files).sort()).toEqual(
    files.map(entry => entry.name).sort(),
  );
  for (const entry of files) {
    if (!entry.name.endsWith('.png')) {
      expect(result.files[entry.name]).toEqual(entry.data);
    }
  }
  const deflated = files.filter(entry => entry.deflated);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const blocks = sum(
    deflated.map(entry => {
      const scan = scanDeflate(
        entry.deflated ?? new Uint8Array(),
        entry.data.length,
      );
      if (!scan.ok) throw new Error(JSON.stringify(scan));
      return scan.blocks;
    }),
  );
  console.info(`${JSON.stringify(work)}, blocks: ${blocks}`);
  // One inflater per deflated file; ignored entries are never inflated.
  expect(work.inflaters).toBe(deflated.length);
  // Each byte of deflate data goes in once, and padding after the final
  // block not at all: fflate would copy it again on every push.
  expect(work.pushed).toBe(
    sum(deflated.map(entry => entry.deflated?.length ?? 0)),
  );
  expect(work.inflated).toBe(sum(deflated.map(entry => entry.data.length)));
  // One scan of each stream: three tables per dynamic block at most, plus
  // the two fixed ones, built once.
  expect(work.tables).toBeLessThanOrEqual(3 * blocks + 2);
});
