import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { expect, test } from 'vitest';
import { unzipBounded } from './unzip.ts';

/** One zip entry as stored in the zip: deflated when non-empty. */
type Part = { name: string; stream: Uint8Array; method: 0 | 8; crc: number };

function localHeader(entry: Part, size: number): Uint8Array {
  const name = strToU8(entry.name);
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(12, 0x21, true); // 1980-01-01
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.stream.byteLength, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  header.set(name, 30);
  return header;
}

function centralEntry(entry: Part, size: number, offset: number): Uint8Array {
  const name = strToU8(entry.name);
  const header = new Uint8Array(46 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.stream.byteLength, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  header.set(name, 46);
  return header;
}

/**
 * A zip assembled by hand. `listed` entries have a local header and a central
 * directory entry (`data` gives their real sizes); `unlisted` entries have a
 * local header only, between the last listed entry and the central directory.
 * Past 65,535 listed entries the end record is written in zip64.
 */
function assemble(
  listed: Part[],
  sizes: Map<string, number>,
  unlisted: Part[] = [],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.byteLength;
  };
  for (const entry of listed) {
    const size = sizes.get(entry.name) ?? 0;
    central.push(centralEntry(entry, size, offset));
    push(localHeader(entry, size));
    push(entry.stream);
  }
  for (const entry of unlisted) {
    push(localHeader(entry, 0));
    push(entry.stream);
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.byteLength, 0);
  const centralOffset = offset;
  const count = listed.length;
  const tail: Uint8Array[] = [];
  if (count >= 0xffff) {
    const record = new Uint8Array(56);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x06064b50, true);
    recordView.setBigUint64(4, 44n, true);
    recordView.setUint16(12, 45, true);
    recordView.setUint16(14, 45, true);
    recordView.setBigUint64(24, BigInt(count), true);
    recordView.setBigUint64(32, BigInt(count), true);
    recordView.setBigUint64(40, BigInt(centralSize), true);
    recordView.setBigUint64(48, BigInt(centralOffset), true);
    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, 0x07064b50, true);
    locatorView.setBigUint64(8, BigInt(centralOffset + centralSize), true);
    locatorView.setUint32(16, 1, true);
    tail.push(record, locator);
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, Math.min(count, 0xffff), true);
  endView.setUint16(10, Math.min(count, 0xffff), true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return new Uint8Array(Buffer.concat([...chunks, ...central, ...tail, end]));
}

// Writes RFC 1951 bits least-significant bit first, including byte alignment
// for stored blocks. Fixtures are generated, never downloaded binary blobs.
class Bits {
  private data: Uint8Array;
  position = 0;
  constructor(capacity = 11 * 1024 * 1024) {
    this.data = new Uint8Array(capacity);
  }
  put(value: number, count: number) {
    for (let bit = 0; bit < count; bit++, this.position++) {
      if ((value >>> bit) & 1)
        this.data[this.position >>> 3] =
          (this.data[this.position >>> 3] ?? 0) | (1 << (this.position & 7));
    }
  }
  align() {
    while (this.position & 7) this.put(0, 1);
  }
  bytes() {
    return this.data.slice(0, Math.ceil(this.position / 8));
  }
}
type BlockKind = 'dynamic-1' | 'dynamic-15' | 'fixed' | 'stored';
function emptyBlock(bits: Bits, kind: BlockKind, final: boolean) {
  bits.put(final ? 1 : 0, 1);
  if (kind === 'stored') {
    bits.put(0, 2);
    bits.align();
    bits.put(0, 16);
    bits.put(65535, 16);
  } else if (kind === 'fixed') {
    bits.put(1, 2);
    bits.put(0, 7); // fixed EOB 256
  } else {
    bits.put(2, 2);
    bits.put(0, 5);
    bits.put(0, 5);
    const wide = kind === 'dynamic-15';
    bits.put(wide ? 15 : 14, 4); // HCLEN: include symbol 15 or stop at 1
    const order = [
      16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];
    for (const symbol of order.slice(0, wide ? 19 : 18)) {
      bits.put(
        wide
          ? [0, 1, 15, 18].includes(symbol)
            ? 2
            : 0
          : symbol === 0
            ? 1
            : [1, 18].includes(symbol)
              ? 2
              : 0,
        3,
      );
    }
    // Canonical code-length codes, reversed for the bit writer:
    // narrow: 0=0, 1=10, 18=11; wide: 0=00,1=01,15=10,18=11.
    for (const repeat of [138, 118]) {
      bits.put(3, 2);
      bits.put(repeat - 11, 7);
    }
    bits.put(1, 2); // EOB length: symbol 15 (10) or 1 (10)
    bits.put(wide ? 2 : 1, 2); // distance length 1 (01 or 10)
    bits.put(0, wide ? 15 : 1); // sole EOB code
  }
}
function bomb(kind: BlockKind): Uint8Array {
  const bits = new Bits();
  const blockBits =
    kind === 'dynamic-1'
      ? 94
      : kind === 'dynamic-15'
        ? 111
        : kind === 'fixed'
          ? 10
          : 40;
  // Leave room for the normal pack + ZIP headers below the HTTP 10 MiB cap.
  const count = Math.floor(((10 * 1024 * 1024 - 16_384) * 8) / blockBits);
  for (let i = 0; i < count; i++) emptyBlock(bits, kind, i === count - 1);
  return bits.bytes();
}
function boundaryStream(
  kind: 'fixed' | 'stored',
  blocks: number,
  output: number,
) {
  const bits = new Bits(20_000);
  for (let i = 1; i < blocks; i++) emptyBlock(bits, kind, false);
  // The final stored block supplies output without introducing extra blocks.
  bits.put(1, 1);
  bits.put(0, 2);
  bits.align();
  bits.put(output, 16);
  bits.put(output ^ 65535, 16);
  for (let i = 0; i < output; i++) bits.put(65, 8);
  return bits.bytes();
}

function zipped(stream: Uint8Array, data = new Uint8Array()) {
  return assemble(
    [{ name: 'payload.bin', stream, method: 8, crc: crc32(data) }],
    new Map([['payload.bin', data.length]]),
  );
}
const digest = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
function accepted(zip: Uint8Array, data: Uint8Array) {
  const result = unzipBounded(zip, 20 * 1024 * 1024);
  expect(result).not.toHaveProperty('issue');
  if (!('files' in result)) throw new Error(JSON.stringify(result));
  const actual = result.files['payload.bin'];
  expect(actual?.length).toBe(data.length);
  if (!actual) throw new Error('Missing payload');
  expect(digest(actual)).toBe(digest(data));
}

test.each<BlockKind>(['dynamic-1', 'dynamic-15', 'fixed', 'stored'])(
  'refuses the %s empty-block CPU bomb in workerd within 500 ms',
  kind => {
    const stream = bomb(kind);
    // Exclude ZIP construction from the measured refusal time.
    const zip = zipped(stream);
    const start = performance.now();
    const result = unzipBounded(zip, 20 * 1024 * 1024);
    const elapsed = performance.now() - start;
    expect(result).toMatchObject({
      issue: { code: 'zip-too-many-blocks', file: 'payload.bin' },
    });
    // Only nine empty blocks need parsing to refuse; 500 ms leaves ample VM
    // scheduling headroom while catching the measured 2-4.4 s table churn.
    expect(elapsed).toBeLessThan(500);
  },
  30_000,
);

test.each(['content', 'empty'] as const)(
  'ignores 9.9 MiB of padding after a final %s deflate block within 500 ms',
  kind => {
    const data =
      kind === 'content'
        ? strToU8('0123456789abcdef'.repeat(2))
        : new Uint8Array();
    const finalBlock =
      kind === 'content'
        ? new Uint8Array(deflateRawSync(data))
        : new Uint8Array([0x03, 0x00]);
    const stream = new Uint8Array(
      finalBlock.length + Math.floor(9.9 * 1024 * 1024),
    );
    stream.set(finalBlock);
    // Both ZIP headers declare only the stream's output as uncompressed size;
    // compressed size includes the trailing padding, all below the upload cap.
    const zip = zipped(stream, data);
    expect(zip.byteLength).toBeLessThan(10 * 1024 * 1024);
    const start = performance.now();
    const result = unzipBounded(zip, 20 * 1024 * 1024);
    const elapsed = performance.now() - start;
    expect(result).not.toHaveProperty('issue');
    if (!('files' in result)) throw new Error(JSON.stringify(result));
    expect(result.files['payload.bin']).toEqual(data);
    // Feeding the trailing bytes to fflate recopies the unconsumed remainder
    // on every 8 KiB push (~1.4 s); ignoring them leaves ample VM headroom.
    expect(elapsed).toBeLessThan(500);
  },
  30_000,
);

test.each(
  [1, 2, 3].flatMap(emptyBlocks =>
    [false, true].map(trailingFixed => ({ emptyBlocks, trailingFixed })),
  ),
)(
  'stored-block alignment after $emptyBlocks short-EOB dynamic blocks preserves bytes (trailing fixed: $trailingFixed)',
  ({ emptyBlocks, trailingFixed }) => {
    const stored = strToU8('Stored bytes after a short EOB.\n');
    const suffix = trailingFixed ? strToU8('END') : new Uint8Array();
    const data = new Uint8Array([...stored, ...suffix]);
    const bits = new Bits(1024);
    for (let i = 0; i < emptyBlocks; i++) {
      emptyBlock(bits, 'dynamic-1', false);
    }
    // A 1-bit EOB can leave whole bytes of lookahead buffered when the
    // following stored block discards padding to reach its LEN/NLEN fields.
    bits.put(trailingFixed ? 0 : 1, 1);
    bits.put(0, 2); // BTYPE 00
    bits.align();
    bits.put(stored.length, 16);
    bits.put(stored.length ^ 65535, 16);
    for (const byte of stored) bits.put(byte, 8);
    if (trailingFixed) {
      bits.put(1, 1); // BFINAL
      bits.put(1, 2); // BTYPE 01
      for (const byte of suffix) {
        // ASCII literals 0..143 have fixed canonical codes 0x30..0xbf;
        // reverse each code for the least-significant-bit-first writer.
        const code = byte + 0x30;
        let reversed = 0;
        for (let bit = 0; bit < 8; bit++) {
          reversed = (reversed << 1) | ((code >>> bit) & 1);
        }
        bits.put(reversed, 8);
      }
      bits.put(0, 7); // fixed EOB 256
    }
    const stream = bits.bytes();
    expect(new Uint8Array(inflateRawSync(stream))).toEqual(data);
    expect(emptyBlocks + 1 + Number(trailingFixed)).toBeLessThanOrEqual(
      8 + Math.floor(data.length / 4096),
    );
    const result = unzipBounded(zipped(stream, data), 20 * 1024 * 1024);
    expect(result).not.toHaveProperty('issue');
    if (!('files' in result)) throw new Error(JSON.stringify(result));
    expect(result.files['payload.bin']).toEqual(data);
  },
);

test.each(
  (['fixed', 'stored'] as const).flatMap(kind =>
    [0, 4095, 4096, 8192].map(output => ({ kind, output })),
  ),
)(
  'the exact block budget accepts $kind at $output output bytes and rejects one more',
  ({ kind, output }) => {
    const data = new Uint8Array(output).fill(65);
    const budget = 8 + Math.floor(output / 4096);
    const exact = boundaryStream(kind, budget, output);
    expect(inflateRawSync(exact).length).toBe(output);
    accepted(zipped(exact, data), data);
    const result = unzipBounded(
      zipped(boundaryStream(kind, budget + 1, output), data),
      20 * 1024 * 1024,
    );
    expect(result, `output=${output}`).toMatchObject({
      issue: { code: 'zip-too-many-blocks', file: 'payload.bin' },
    });
  },
);

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  let state = 0x15ab1927;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 255;
  }
  return bytes;
}

test.each(['text', 'random'])(
  'honest zlib levels and strategies preserve %s bytes',
  kind => {
    const data =
      kind === 'random'
        ? randomBytes(2 * 1024 * 1024)
        : strToU8('臺灣 PDF fixture: honest deflate data.\n'.repeat(55_000));
    for (let level = 0; level <= 9; level++) {
      for (const strategy of [
        constants.Z_DEFAULT_STRATEGY,
        constants.Z_FILTERED,
        constants.Z_HUFFMAN_ONLY,
        constants.Z_RLE,
        constants.Z_FIXED,
      ]) {
        accepted(
          zipped(
            new Uint8Array(deflateRawSync(data, { level, strategy })),
            data,
          ),
          data,
        );
      }
    }
  },
  30_000,
);

test('honest fflate levels preserve large text and random bytes', () => {
  const data = [
    strToU8('公司月報 fixture '.repeat(100_000)),
    randomBytes(2 * 1024 * 1024),
  ];
  for (const bytes of data)
    for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      accepted(zipSync({ 'payload.bin': bytes }, { level }), bytes);
    }
}, 30_000);

test('a larger neighboring entry cannot lend its output-derived allowance to an empty stream', () => {
  const data = new Uint8Array(32_768).fill(65);
  const stream = boundaryStream('fixed', 9, 0);
  const zip = assemble(
    [
      {
        name: 'neighbor.bin',
        stream: new Uint8Array(deflateRawSync(data)),
        method: 8,
        crc: crc32(data),
      },
      { name: 'payload.bin', stream, method: 8, crc: 0 },
    ],
    new Map([
      ['neighbor.bin', data.length],
      ['payload.bin', 0],
    ]),
  );
  expect(unzipBounded(zip, 20 * 1024 * 1024)).toMatchObject({
    issue: { code: 'zip-too-many-blocks', file: 'payload.bin' },
  });
});

test('a lying output-size header cannot buy extra blocks for an actually empty stream', () => {
  const stream = boundaryStream('fixed', 9, 0);
  const zip = zipped(stream, new Uint8Array(4096));
  expect(unzipBounded(zip, 20 * 1024 * 1024)).toMatchObject({
    issue: { code: 'zip-too-many-blocks', file: 'payload.bin' },
  });
});
