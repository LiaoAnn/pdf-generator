import { Buffer } from 'node:buffer';
import { strToU8 } from 'fflate';

/** One zip entry as stored in the zip: deflated when non-empty. */
type Part = {
  name: string;
  stream: Uint8Array;
  method: 0 | 8;
  crc: number;
};

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
export function assemble(
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

export class Bits {
  private data = new Uint8Array(11 * 1024 * 1024);
  position = 0;
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
function codes(lengths: number[]) {
  const counts = Array<number>(16).fill(0);
  for (const length of lengths)
    if (length) counts[length] = (counts[length] ?? 0) + 1;
  const next = Array<number>(16).fill(0);
  let code = 0;
  for (let n = 1; n <= 15; n++) {
    code = (code + (counts[n - 1] ?? 0)) << 1;
    next[n] = code;
  }
  return lengths.map(length => {
    const value = next[length] ?? 0;
    next[length] = value + 1;
    let reversed = 0;
    for (let i = 0; i < length; i++)
      reversed = (reversed << 1) | ((value >>> i) & 1);
    return reversed;
  });
}
export function chain(width: number, size: number, last: number) {
  const lengths = Array<number>(size).fill(0);
  for (let i = 0; i < width - 1; i++) lengths[i] = i + 1;
  lengths[width - 1] = width;
  lengths[last] = width;
  return lengths;
}
// A complete 4-bit code-length alphabet encodes lengths 0..15 directly.
// Setting incomplete leaves a valid incomplete alphabet (all codes length 5).
export function dynamic(
  bits: Bits,
  literals: number[],
  distances: number[],
  final: boolean,
  incomplete = false,
) {
  bits.put(Number(final), 1);
  bits.put(2, 2);
  bits.put(literals.length - 257, 5);
  bits.put(distances.length - 1, 5);
  bits.put(15, 4);
  const order = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
  ];
  const cl = Array.from({ length: 19 }, (_, i) =>
    i < 16 ? (incomplete ? 5 : 4) : 0,
  );
  for (const symbol of order) bits.put(cl[symbol] ?? 0, 3);
  const cc = codes(cl);
  for (const length of [...literals, ...distances])
    bits.put(cc[length] ?? 0, cl[length] ?? 0);
  const lc = codes(literals),
    dc = codes(distances);
  return {
    literal(symbol: number) {
      bits.put(lc[symbol] ?? 0, literals[symbol] ?? 0);
    },
    distance(symbol: number) {
      bits.put(dc[symbol] ?? 0, distances[symbol] ?? 0);
    },
  };
}
export function stored(bits: Bits, bytes: Uint8Array, final: boolean) {
  bits.put(Number(final), 1);
  bits.put(0, 2);
  bits.align();
  bits.put(bytes.length, 16);
  bits.put(bytes.length ^ 65535, 16);
  for (const byte of bytes) bits.put(byte, 8);
}
export function longStream(width: number, count: number) {
  const bits = new Bits();
  const lengths = chain(width, 257, 256);
  const block = dynamic(bits, lengths, [1], true);
  for (let i = 0; i < count; i++) block.literal(width - 1);
  block.literal(256);
  return { stream: bits.bytes(), data: new Uint8Array(count).fill(width - 1) };
}
export function thirteenBlocks() {
  const bits = new Bits();
  const lengths = chain(15, 257, 256);
  for (let i = 0; i < 13; i++) {
    const block = dynamic(bits, lengths, [1], i === 12);
    for (let j = 0; j < 1600; j++) block.literal(0);
    block.literal(256);
  }
  return { stream: bits.bytes(), data: new Uint8Array(13 * 1600).fill(0) };
}
