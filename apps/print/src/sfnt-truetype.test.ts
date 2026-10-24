import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { patchCmap, readCmap } from './fonts/sfnt.ts';
import { fontTables, metrics, sum32 } from './test-fixtures/read-cff.ts';
import {
  glyphRecords,
  postNames,
  tableBytes,
  withTables,
} from './test-fixtures/read-ttf.ts';
import { withSharedCmap } from './test-fixtures/shared-cmap.ts';

const lxgw = async () =>
  withSharedCmap(
    await readFile(
      new URL('../public/fonts/LXGWWenKaiTC-Regular.ttf', import.meta.url),
    ),
    true,
  );

// The T03 drop policy, independently applied to the collision fixture cmap.
const alias = (cp: number) =>
  (cp >= 0x2e80 && cp <= 0x2fdf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f) ||
  [0x2329, 0x232a, 0x301c].includes(cp);

function expectedMapping(source: Uint8Array) {
  const original = [...readCmap(source)].sort((a, b) => a[0] - b[0]);
  const nonAliasGlyphs = new Set(
    original.filter(([cp]) => !alias(cp)).map(([, gid]) => gid),
  );
  const dropped = original
    .filter(([cp, gid]) => alias(cp) && nonAliasGlyphs.has(gid))
    .map(([cp]) => cp);
  const kept = original.filter(([cp]) => !dropped.includes(cp));
  const keepers = new Map<number, number>();
  for (const [cp, gid] of kept) {
    if (!keepers.has(gid) || cp === 0x2013) keepers.set(gid, cp);
  }
  const copied: number[] = [];
  const count = tableBytes(source, 'maxp').readUInt16BE(4);
  const mapping = kept.map(([cp, gid]) => {
    if (keepers.get(gid) === cp) return [cp, gid];
    copied.push(cp);
    return [cp, count + copied.length - 1];
  });
  return { mapping, copied, dropped };
}

test('LXGW copies every surviving shared glyph in code-point order without changing outlines, compressed metrics or post names', async () => {
  const source = await lxgw();
  const expected = expectedMapping(source);
  expect(expected.copied.length).toBeGreaterThan(0);
  expect(expected.dropped).toEqual(expect.arrayContaining([0x2329, 0x301c]));
  expect(expected.dropped.some(cp => cp >= 0xf900 && cp <= 0xfaff)).toBe(true);
  expect(tableBytes(source, 'vhea').readUInt16BE(34)).toBe(1);
  expect(tableBytes(source, 'head').readInt16BE(50)).toBe(1);
  const oldRecords = glyphRecords(source);
  const oldNames = postNames(tableBytes(source, 'post'));
  expect(oldNames).toHaveLength(oldRecords.length);

  const result = patchCmap(source);
  expect(result.dropped).toEqual(expected.dropped);
  expect(result.copied).toEqual(expected.copied);
  const mapping = readCmap(result.font);
  expect(mapping.size).toBe(expected.mapping.length);
  expect(
    expected.mapping.every(([cp, gid]) => mapping.get(cp as number) === gid),
    'all code-point mappings',
  ).toBe(true);
  expect(mapping.has(0x3008)).toBe(true);
  expect(mapping.has(0xff5e)).toBe(true);
  expect(new Set(mapping.values()).size).toBe(mapping.size);
  const count = oldRecords.length + expected.copied.length;
  expect(tableBytes(result.font, 'maxp').readUInt16BE(4)).toBe(count);
  expect(tableBytes(result.font, 'head').readInt16BE(50)).toBe(1);
  const records = glyphRecords(result.font);
  expect(records).toHaveLength(count);
  const inputMap = readCmap(source);
  const sourceIds = [
    ...oldRecords.map((_, gid) => gid),
    ...expected.copied.map(cp => inputMap.get(cp) as number),
  ];
  expect(
    records.every((bytes, gid) =>
      bytes.equals(oldRecords[sourceIds[gid] as number] as Buffer),
    ),
    'all original and copied glyf records match their source outlines',
  ).toBe(true);
  for (const [tag, header] of [
    ['hmtx', 'hhea'],
    ['vmtx', 'vhea'],
  ] as const) {
    const before = metrics(
      tableBytes(source, tag),
      tableBytes(source, header),
      oldRecords.length,
    );
    const after = metrics(
      tableBytes(result.font, tag),
      tableBytes(result.font, header),
      count,
    );
    expect(after.length).toBe(sourceIds.length);
    expect(
      after.every((metric, gid) => {
        const expected = before[sourceIds[gid] as number];
        return metric[0] === expected?.[0] && metric[1] === expected?.[1];
      }),
      `${tag} resolved advances and side bearings`,
    ).toBe(true);
  }
  const names = postNames(tableBytes(result.font, 'post'));
  expect(names).toHaveLength(count);
  expect(
    oldNames.every((name, gid) => names[gid] === name),
    'original post names unchanged',
  ).toBe(true);
});

test('LXGW rebuilding preserves unrelated tables and valid checksums without mutation, nondeterminism or second-pass copies', async () => {
  const source = await lxgw();
  const original = Buffer.from(source);
  const result = patchCmap(source);
  expect(source.equals(original), 'input unchanged').toBe(true);
  expect(
    Buffer.from(patchCmap(source).font).equals(Buffer.from(result.font)),
    'deterministic output',
  ).toBe(true);
  const second = patchCmap(result.font);
  expect(second.copied).toEqual([]);
  expect(second.dropped).toEqual([]);
  expect(
    Buffer.from(second.font).equals(Buffer.from(result.font)),
    'byte-idempotent output',
  ).toBe(true);
  const before = fontTables(source);
  const after = fontTables(result.font);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  const changed = new Set([
    'cmap',
    'head',
    'maxp',
    'glyf',
    'loca',
    'hhea',
    'hmtx',
    'vhea',
    'vmtx',
    'post',
  ]);
  for (const [tag, entry] of after) {
    if (!changed.has(tag))
      expect(
        entry.bytes.equals(before.get(tag)?.bytes as Buffer),
        `${tag} unchanged`,
      ).toBe(true);
    const bytes = Buffer.from(entry.bytes);
    if (tag === 'head') bytes.writeUInt32BE(0, 8);
    expect(entry.offset % 4, `${tag} alignment`).toBe(0);
    expect(sum32(bytes), `${tag} checksum`).toBe(entry.checksum);
  }
  expect(sum32(result.font)).toBe(0xb1b0afba);
});

test.each([
  'hdmx',
  'LTSH',
  'gvar',
  'HVAR',
  'VVAR',
  'CFF2',
  'sbix',
  'CBDT',
  'CBLC',
  'EBDT',
  'EBLC',
  'COLR',
  'SVG ',
])(
  'refuses LXGW copies with unsupported %s glyph data instead of silently leaving stale glyph counts',
  async tag => {
    // The guard must run before interpreting a table it cannot extend.
    const source = withTables(await lxgw(), [[tag, Buffer.alloc(4)]]);
    expect(() => patchCmap(source)).toThrow(new RegExp(tag.trim()));
  },
);
