import { readdirSync, readFileSync } from 'node:fs';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { deflateSync } from 'fflate';
import { expect, test } from 'vitest';
import { scanDeflate } from './deflate-blocks.ts';
import { scanDeflateReference } from './deflate-blocks-reference.ts';
import {
  Bits,
  chain,
  dynamic,
  longStream,
  stored,
  thirteenBlocks,
} from './deflate-fixtures.test-support.ts';

type Case = { name: string; stream: Uint8Array; size: number };
function files(root: URL): URL[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    return entry.isDirectory() ? files(url) : [url];
  });
}
function generated(): Case[] {
  const cases: Case[] = [];
  for (let width = 1; width <= 15; width++) {
    const value = longStream(width, 257);
    expect(inflateRawSync(value.stream).length).toBe(value.data.length);
    cases.push({
      name: `long-${width}`,
      stream: value.stream,
      size: value.data.length,
    });
  }
  const many = thirteenBlocks();
  cases.push({
    name: '13-dynamic-blocks',
    stream: many.stream,
    size: many.data.length,
  });
  for (const distances of [[1], [0], chain(15, 30, 29)]) {
    for (const incomplete of [false, true]) {
      const bits = new Bits();
      const seed = new Uint8Array(32768).fill(0);
      stored(bits, seed, false);
      const literal = chain(15, 258, 257);
      literal[256] = 15;
      literal[14] = 0; // retain complete tree, move deepest literal to EOB
      const block = dynamic(bits, literal, distances, false, incomplete);
      block.literal(0);
      if (distances.length === 30) {
        block.literal(257);
        block.distance(29);
        bits.put(0, 13);
      }
      block.literal(256);
      stored(bits, new Uint8Array([65, 66]), false);
      bits.put(1, 1);
      bits.put(1, 2);
      bits.put(0, 7); // final fixed EOB
      const stream = bits.bytes();
      if (!incomplete)
        expect(inflateRawSync(stream).length).toBe(
          32771 + (distances.length === 30 ? 3 : 0),
        );
      cases.push({
        name: `mixed-distance-${distances.length}-${distances[0]}-incomplete-${incomplete}`,
        stream,
        size: 32771 + (distances.length === 30 ? 3 : 0),
      });
      cases.push({
        name: 'final-padding',
        stream: new Uint8Array([...stream, 255, 17, 0, 128]),
        size: 32771 + (distances.length === 30 ? 3 : 0),
      });
    }
  }
  for (const bad of ['oversubscribed', 'missing-eob']) {
    const bits = new Bits();
    const literal = Array<number>(257).fill(0);
    literal[0] = 1;
    literal[1] = 1;
    if (bad === 'oversubscribed') literal[256] = 1;
    dynamic(bits, literal, [1], true).literal(0);
    cases.push({ name: bad, stream: bits.bytes(), size: 100 });
  }
  // Truncate every byte of several trees, including 10/15-bit payloads.
  const truncations = cases.filter(c =>
    ['long-1', 'long-10', 'long-15'].includes(c.name),
  );
  for (const c of truncations) {
    for (let i = 0; i < c.stream.length; i++)
      cases.push({
        name: `${c.name}-cut-${i}`,
        stream: c.stream.slice(0, i),
        size: c.size,
      });
  }
  const short = new Bits();
  stored(short, new Uint8Array(25), false);
  short.put(1, 1);
  short.put(1, 2);
  short.put(0, 7);
  for (let i = 0; i < short.bytes().length; i++)
    cases.push({
      name: `stored-fixed-cut-${i}`,
      stream: short.bytes().slice(0, i),
      size: 25,
    });
  let state = 0x1542026;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const seeds = cases.slice(0, 16);
  for (let i = 0; i < 4000; i++) {
    const seed = seeds[random() % seeds.length];
    if (!seed) throw new Error('Missing mutation seed');
    const stream = seed.stream.slice();
    const at = random() % stream.length;
    stream[at] = (stream[at] ?? 0) ^ (1 << (random() % 8));
    cases.push({ name: `mutation-${i}`, stream, size: seed.size });
  }
  return cases;
}

test('preserves the full reference verdict on real compressors, long trees, malformed headers, truncations and seeded mutations', () => {
  let streams = 0,
    comparisons = 0,
    realFiles = 0;
  const check = ({ name, stream, size }: Case) => {
    streams++;
    for (const limit of [size, Math.max(0, size - 1), size + 4096]) {
      expect(scanDeflate(stream, limit), `${name}, limit ${limit}`).toEqual(
        scanDeflateReference(stream, limit),
      );
      comparisons++;
    }
  };
  const root = new URL('../../../../templates/', import.meta.url);
  for (const pack of [
    'minimal-example',
    'monthly-report',
    'incident-form',
    'financial-statement',
    'paper',
    'bank-statement',
  ]) {
    for (const url of files(new URL(`${pack}/pack/`, root))) {
      const bytes = new Uint8Array(readFileSync(url));
      realFiles++;
      for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const)
        check({
          name: `${url.pathname}/fflate-${level}`,
          stream: deflateSync(bytes, { level }),
          size: bytes.length,
        });
      for (let level = 1; level <= 9; level++)
        for (const strategy of [
          constants.Z_DEFAULT_STRATEGY,
          constants.Z_FILTERED,
          constants.Z_HUFFMAN_ONLY,
          constants.Z_RLE,
          constants.Z_FIXED,
        ])
          for (const memLevel of [1, 9]) {
            check({
              name: `${url.pathname}/zlib-${level}-${strategy}-${memLevel}`,
              stream: new Uint8Array(
                deflateRawSync(bytes, { level, strategy, memLevel }),
              ),
              size: bytes.length,
            });
          }
    }
  }
  for (const value of generated()) check(value);
  console.info(JSON.stringify({ realFiles, streams, comparisons }));
}, 60_000);
