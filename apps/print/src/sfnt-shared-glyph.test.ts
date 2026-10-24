import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { patchCmap, readCmap } from './fonts/sfnt.ts';
import {
  fontTables,
  metrics,
  origins,
  readCff,
  sum32,
} from './test-fixtures/read-cff.ts';

type CopyResult = { font: Uint8Array; dropped: number[]; copied: number[] };
// The API is extended in this slice. Keep the tests typecheckable while RED.
const patch = patchCmap as (font: Uint8Array) => CopyResult;

const faces = [
  'NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf',
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
];

test.each(faces)(
  '%s appends independent CFF glyphs in code-point order with identical outlines, FDs and resolved metrics',
  async name => {
    const source = await readFile(
      new URL(`../public/fonts/${name}`, import.meta.url),
    );
    const original = Buffer.from(source);
    const tables = fontTables(source);
    const table = (tag: string) => {
      const bytes = tables.get(tag)?.bytes;
      if (!bytes) throw new Error(`fixture lacks ${tag}`);
      return bytes;
    };
    const oldCount = table('maxp').readUInt16BE(4);
    const before = readCff(table('CFF '));
    // Sanity-check the independent decoder against the fixture, before patching.
    expect(before.charstrings).toHaveLength(oldCount);
    expect(before.cids).toHaveLength(oldCount);
    expect(before.fds).toHaveLength(oldCount);
    expect(new Set(before.cids).size).toBe(oldCount);
    const oldMap = [...readCmap(source)].sort((a, b) => a[0] - b[0]);
    const seen = new Set<number>();
    const copies: number[] = [];
    const expectedMap = oldMap.map(([cp, gid]) => {
      if (!seen.has(gid)) {
        seen.add(gid);
        return [cp, gid];
      }
      copies.push(cp);
      return [cp, oldCount + copies.length - 1];
    });
    // These committed fonts already have T03 aliases removed; remaining sharing
    // includes punctuation, which must be copied rather than deleted.
    expect(copies.length).toBeGreaterThan(0);
    expect(copies).toContain(0xff0f);
    if (name.includes('Serif')) {
      expect(table('hhea').readUInt16BE(34)).toBeLessThan(oldCount);
      expect(table('vhea').readUInt16BE(34)).toBeLessThan(oldCount);
    }

    const result = patch(source);
    expect(result.copied).toEqual(copies);
    expect(result.dropped).toEqual([]);
    const afterMap = readCmap(result.font);
    expect([...afterMap]).toEqual(expectedMap);
    expect(new Set(afterMap.values()).size).toBe(oldMap.length);
    expect(source.equals(original), 'source font unchanged').toBe(true);
    expect(
      Buffer.from(patch(source).font).equals(Buffer.from(result.font)),
      'repeated patches are byte-identical',
    ).toBe(true);
    const second = patch(result.font);
    expect(second.copied).toEqual([]);
    expect(second.dropped).toEqual([]);
    expect(
      Buffer.from(second.font).equals(Buffer.from(result.font)),
      'patching is byte-idempotent',
    ).toBe(true);
    const updated = fontTables(result.font);
    const nextTable = (tag: string) => {
      const bytes = updated.get(tag)?.bytes;
      if (!bytes) throw new Error(`patched font lacks ${tag}`);
      return bytes;
    };
    const count = oldCount + copies.length;
    expect(nextTable('maxp').readUInt16BE(4)).toBe(count);
    const after = readCff(nextTable('CFF '));
    expect(after.charstrings).toHaveLength(count);
    expect(after.cids).toHaveLength(count);
    expect(after.fds).toHaveLength(count);
    expect(new Set(after.cids).size).toBe(count);
    expect(after.cids.slice(0, oldCount)).toEqual(before.cids);
    expect(after.fds.slice(0, oldCount)).toEqual(before.fds);
    expect(
      after.charstrings
        .slice(0, oldCount)
        .every((bytes, gid) => bytes.equals(before.charstrings[gid] as Buffer)),
      'existing charstrings unchanged',
    ).toBe(true);
    const inputMap = new Map(oldMap);
    for (const [i, cp] of copies.entries()) {
      const from = inputMap.get(cp) as number;
      const to = oldCount + i;
      expect(after.charstrings[to], `U+${cp.toString(16)} charstring`).toEqual(
        before.charstrings[from],
      );
      expect(after.fds[to], `U+${cp.toString(16)} FDSelect`).toBe(
        before.fds[from],
      );
    }
    for (const [metricTag, headerTag] of [
      ['hmtx', 'hhea'],
      ['vmtx', 'vhea'],
    ] as const) {
      const oldMetrics = metrics(table(metricTag), table(headerTag), oldCount);
      const newMetrics = metrics(
        nextTable(metricTag),
        nextTable(headerTag),
        count,
      );
      expect(newMetrics).toEqual([
        ...oldMetrics,
        ...copies.map(cp => oldMetrics[inputMap.get(cp) as number]),
      ]);
    }
    const oldOrigins = origins(table('VORG'), oldCount);
    expect(origins(nextTable('VORG'), count)).toEqual([
      ...oldOrigins,
      ...copies.map(cp => oldOrigins[inputMap.get(cp) as number]),
    ]);
    // Glyph changes must not silently strip layout features or identity tables.
    const changed = new Set([
      'cmap',
      'head',
      'CFF ',
      'maxp',
      'hhea',
      'hmtx',
      'vhea',
      'vmtx',
      'VORG',
    ]);
    expect([...updated.keys()].sort()).toEqual([...tables.keys()].sort());
    for (const [tag, entry] of updated) {
      if (!changed.has(tag))
        expect(entry.bytes.equals(table(tag)), `${tag} payload unchanged`).toBe(
          true,
        );
      const bytes = Buffer.from(entry.bytes);
      if (tag === 'head') bytes.writeUInt32BE(0, 8);
      expect(entry.offset % 4, `${tag} alignment`).toBe(0);
      expect(sum32(bytes), `${tag} checksum`).toBe(entry.checksum);
    }
    expect(sum32(result.font)).toBe(0xb1b0afba);
    const cmap = nextTable('cmap');
    expect(cmap.subarray(0, 14)).toEqual(
      Buffer.from([0, 0, 0, 1, 0, 3, 0, 10, 0, 0, 0, 12, 0, 12]),
    );
  },
);
