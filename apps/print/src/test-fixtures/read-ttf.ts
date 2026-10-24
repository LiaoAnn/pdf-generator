// Independent readers for the TrueType records changed by glyph copying.
import { fontTables, sum32 } from './read-cff.ts';

export function tableBytes(font: Uint8Array, tag: string) {
  const bytes = fontTables(font).get(tag)?.bytes;
  if (!bytes) throw new Error(`fixture lacks ${tag}`);
  return bytes;
}

export function glyphRecords(font: Uint8Array) {
  const tables = fontTables(font);
  const get = (tag: string) => {
    const bytes = tables.get(tag)?.bytes;
    if (!bytes) throw new Error(`fixture lacks ${tag}`);
    return bytes;
  };
  const count = get('maxp').readUInt16BE(4);
  const long = get('head').readInt16BE(50) === 1;
  const loca = get('loca');
  if (loca.length !== (count + 1) * (long ? 4 : 2))
    throw new Error('loca length does not match numGlyphs');
  const offsets = Array.from({ length: count + 1 }, (_, i) =>
    long ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2,
  );
  const glyf = get('glyf');
  return Array.from({ length: count }, (_, i) => {
    const start = offsets[i] as number;
    let end = offsets[i + 1] as number;
    if (start > end || end > glyf.length)
      throw new Error('loca points outside glyf or goes backwards');
    // Trailing zero bytes are indistinguishable from alignment padding here.
    while (end > start && glyf[end - 1] === 0) end--;
    return glyf.subarray(start, end);
  });
}

export function postNames(post: Buffer) {
  if (post.readUInt32BE(0) !== 0x00020000)
    throw new Error('expected post version 2');
  const count = post.readUInt16BE(32);
  const indices = Array.from({ length: count }, (_, i) =>
    post.readUInt16BE(34 + 2 * i),
  );
  const custom: string[] = [];
  let at = 34 + 2 * count;
  while (at < post.length) {
    const length = post[at++] as number;
    if (at + length > post.length) throw new Error('truncated post name');
    custom.push(post.toString('ascii', at, at + length));
    at += length;
  }
  return indices.map(index => {
    if (index < 258) return `standard:${index}`;
    const name = custom[index - 258];
    if (!name || !/^[\x21-\x7e]+$/.test(name))
      throw new Error(`invalid post name index ${index}`);
    return `custom:${name}`;
  });
}

// Repack a real font with extra tables to exercise unsupported-table guards.
// No production serializer is used, so the guard cannot pass on its own output.
export function withTables(font: Uint8Array, extra: [string, Buffer][]) {
  const tables = new Map<string, Buffer>(
    [...fontTables(font)].map(([tag, entry]) => [tag, entry.bytes]),
  );
  for (const [tag, bytes] of extra) tables.set(tag, bytes);
  const header = Buffer.alloc(12 + 16 * tables.size);
  header.set(font.subarray(0, 4));
  header.writeUInt16BE(tables.size, 4);
  const power = 2 ** Math.floor(Math.log2(tables.size));
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(tables.size * 16 - power * 16, 10);
  const parts = [header];
  let offset = header.length;
  let headAt = 0;
  let i = 0;
  for (const [tag, original] of tables) {
    const bytes = Buffer.from(original);
    if (tag === 'head') {
      bytes.writeUInt32BE(0, 8);
      headAt = offset;
    }
    const entry = 12 + 16 * i++;
    header.write(tag, entry, 'ascii');
    header.writeUInt32BE(sum32(bytes), entry + 4);
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(bytes.length, entry + 12);
    const padding = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    parts.push(bytes, padding);
    offset += bytes.length + padding.length;
  }
  const result = Buffer.concat(parts);
  result.writeUInt32BE((0xb1b0afba - sum32(result)) >>> 0, headAt + 8);
  return result;
}
