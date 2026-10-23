import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { expect, test } from 'vitest';

// Independent binary fixtures: no font downloads, font libraries, or production builder.
type Group = readonly [start: number, end: number, glyph: number];
function format12(groups: readonly Group[]) {
  const bytes = Buffer.alloc(16 + 12 * groups.length);
  bytes.writeUInt16BE(12);
  bytes.writeUInt32BE(bytes.length, 4);
  bytes.writeUInt32BE(groups.length, 12);
  groups.forEach(([start, end, glyph], i) => {
    bytes.writeUInt32BE(start, 16 + i * 12);
    bytes.writeUInt32BE(end, 20 + i * 12);
    bytes.writeUInt32BE(glyph, 24 + i * 12);
  });
  return bytes;
}

function format4() {
  // A–C use idDelta; 一/丁 use glyphIdArray with a nonzero delta.
  const bytes = Buffer.alloc(44);
  [
    4, 44, 0, 6, 4, 1, 2, 0x43, 0x4e01, 0xffff, 0, 0x41, 0x4e00, 0xffff, 0xffc4,
    2, 1, 0, 4, 0, 8, 9,
  ].forEach((value, i) => {
    bytes.writeUInt16BE(value, i * 2);
  });
  return bytes;
}

function cmap(subtables: readonly { encoding: number; bytes: Buffer }[]) {
  const header = Buffer.alloc(4 + 8 * subtables.length);
  header.writeUInt16BE(subtables.length, 2);
  let offset = header.length;
  subtables.forEach(({ encoding, bytes }, i) => {
    header.writeUInt16BE(3, 4 + i * 8);
    header.writeUInt16BE(encoding, 6 + i * 8);
    header.writeUInt32BE(offset, 8 + i * 8);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...subtables.map(sub => sub.bytes)]);
}

function checksum(bytes: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word =
      (bytes[i] ?? 0) * 0x1000000 +
      ((bytes[i + 1] ?? 0) << 16) +
      ((bytes[i + 2] ?? 0) << 8) +
      (bytes[i + 3] ?? 0);
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function makeFont(mapping: Buffer) {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  const maxp = Buffer.from([0, 0, 0x50, 0, 0, 100]);
  const tables = [
    ['cmap', mapping],
    ['head', head],
    ['maxp', maxp],
    ['TEST', Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a])],
  ] as const;
  const header = Buffer.alloc(12 + tables.length * 16);
  header.writeUInt32BE(0x00010000);
  header.writeUInt16BE(tables.length, 4);
  header.writeUInt16BE(64, 6);
  header.writeUInt16BE(2, 8);
  const bodies: Buffer[] = [];
  let offset = header.length;
  tables.forEach(([tag, bytes], i) => {
    header.write(tag, 12 + i * 16, 'latin1');
    header.writeUInt32BE(checksum(bytes), 16 + i * 16);
    header.writeUInt32BE(offset, 20 + i * 16);
    header.writeUInt32BE(bytes.length, 24 + i * 16);
    const padding = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    bodies.push(bytes, padding);
    offset += bytes.length + padding.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headOffset = directory(font).get('head')?.offset;
  if (headOffset === undefined) throw new Error('fixture lacks head');
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

function directory(input: Uint8Array) {
  const font = Buffer.from(input);
  const tables = new Map<
    string,
    { offset: number; checksum: number; bytes: Buffer }
  >();
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    const offset = font.readUInt32BE(at + 8);
    tables.set(font.toString('latin1', at, at + 4), {
      offset,
      checksum: font.readUInt32BE(at + 4),
      bytes: font.subarray(offset, offset + font.readUInt32BE(at + 12)),
    });
  }
  return tables;
}

const aliases = [
  0x2329, 0x232a, 0x2e80, 0x2f00, 0x2fdf, 0x301c, 0xf900, 0xfaff, 0x2f800,
  0x2fa1f,
];
const mapping: Group[] = (
  [
    ...aliases.map((cp): Group => [cp, cp, 20]),
    [0x4e00, 0x4e02, 20], // consecutive code points and glyphs
    [0x2eab, 0x2eab, 30],
    [0xfa5d, 0xfa5d, 30], // alias-only pair
    [0xf907, 0xf907, 31], // sole alias for its glyph
    ...[
      0x2e7f, 0x2fe0, 0xf8ff, 0xfb00, 0x2f7ff, 0x2fa20, 0x2328, 0x232b, 0x301b,
      0x301d,
    ].map((cp): Group => [cp, cp, 20]), // just outside every removal boundary
  ] satisfies Group[]
).sort((a, b) => a[0] - b[0]);

function fixture() {
  return makeFont(cmap([{ encoding: 10, bytes: format12(mapping) }]));
}

// Import inside each test so missing implementation reports RED for each behavior.
test('prefers Windows full-Unicode cmap over a conflicting BMP cmap and expands format-12 groups', async () => {
  const { readCmap } = await import('./fonts/sfnt.ts');
  const font = makeFont(
    cmap([
      { encoding: 1, bytes: format4() },
      {
        encoding: 10,
        bytes: format12([
          [0x4e00, 0x4e02, 40],
          [0x20000, 0x20001, 50],
        ]),
      },
    ]),
  );
  expect(readCmap(font)).toEqual(
    new Map([
      [0x4e00, 40],
      [0x4e01, 41],
      [0x4e02, 42],
      [0x20000, 50],
      [0x20001, 51],
    ]),
  );
});

test('falls back to BMP format 4 with both delta and glyph-array mappings without mapping the sentinel', async () => {
  const { readCmap } = await import('./fonts/sfnt.ts');
  expect(readCmap(makeFont(cmap([{ encoding: 1, bytes: format4() }])))).toEqual(
    new Map([
      [0x41, 5],
      [0x42, 6],
      [0x43, 7],
      [0x4e00, 10],
      [0x4e01, 11],
    ]),
  );
});

test('drops only shared aliases, keeps unified ideographs and alias-only glyphs, and sorts dropped code points', async () => {
  const { readCmap, patchCmap } = await import('./fonts/sfnt.ts');
  const { font, dropped } = patchCmap(fixture());
  const expected = new Map<number, number>();
  for (const [start, end, glyph] of mapping) {
    for (let cp = start; cp <= end; cp++) {
      if (!aliases.includes(cp)) expected.set(cp, glyph + cp - start);
    }
  }
  expect(dropped).toEqual(aliases);
  expect(readCmap(font)).toEqual(expected);
});

test('rebuilds a single Windows format-12 cmap, preserves other table payloads, and repairs sfnt checksums without mutating the input', async () => {
  const { patchCmap } = await import('./fonts/sfnt.ts');
  const source = fixture();
  const original = Buffer.from(source);
  const result = patchCmap(source);
  expect(source).toEqual(original);
  const tables = directory(result.font);
  expect([...tables.keys()].sort()).toEqual(
    [...directory(source).keys()].sort(),
  );
  const newCmap = tables.get('cmap')?.bytes;
  expect(newCmap?.subarray(0, 14)).toEqual(
    Buffer.from([0, 0, 0, 1, 0, 3, 0, 10, 0, 0, 0, 12, 0, 12]),
  );
  for (const [tag, table] of tables) {
    const data = Buffer.from(table.bytes);
    expect(table.offset % 4, `${tag} alignment`).toBe(0);
    if (tag === 'head') data.writeUInt32BE(0, 8);
    expect(checksum(data), `${tag} directory checksum`).toBe(table.checksum);
    if (tag === 'cmap') continue;
    const before = Buffer.from(directory(source).get(tag)?.bytes ?? []);
    if (tag === 'head') before.writeUInt32BE(0, 8);
    expect(data, `${tag} payload`).toEqual(before);
  }
  expect(checksum(result.font)).toBe(0xb1b0afba);
});

test('patches a format-4 input into format 12 without changing its glyph mappings', async () => {
  const { readCmap, patchCmap } = await import('./fonts/sfnt.ts');
  const result = patchCmap(makeFont(cmap([{ encoding: 1, bytes: format4() }])));
  expect(result.dropped).toEqual([]);
  expect(readCmap(result.font)).toEqual(
    new Map([
      [0x41, 5],
      [0x42, 6],
      [0x43, 7],
      [0x4e00, 10],
      [0x4e01, 11],
    ]),
  );
  expect(directory(result.font).get('cmap')?.bytes.readUInt16BE(6)).toBe(10);
  expect(directory(result.font).get('cmap')?.bytes.readUInt16BE(12)).toBe(12);
});

test.each([
  'NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf',
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
])(
  'committed %s keeps 一 while removing the radical that corrupts PDF extraction',
  async name => {
    const { readCmap } = await import('./fonts/sfnt.ts');
    const font = await readFile(
      new URL(`../public/fonts/${name}`, import.meta.url),
    );
    const mapping = readCmap(font);
    expect(mapping.has(0x2f00)).toBe(false);
    expect(mapping.get(0x4e00)).toBeGreaterThan(0);
  },
);
