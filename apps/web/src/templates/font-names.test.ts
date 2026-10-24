import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, deflateSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import { postScriptName } from './font-names.ts';

type NameRecord = { platform: number; name: string; id?: number };

// Minimal name-only fonts keep fallback/format coverage independent of large
// binary fixtures. The upload test covers a real font with outlines in WOFF2.
function nameTable(records: NameRecord[]): Buffer {
  const strings = records.map(record => {
    if (record.platform === 1) return Buffer.from(record.name, 'latin1');
    const bytes = Buffer.from(record.name, 'utf16le');
    return bytes.swap16();
  });
  const start = 6 + records.length * 12;
  const table = Buffer.alloc(
    start + strings.reduce((sum, bytes) => sum + bytes.length, 0) + 256,
  );
  table.writeUInt16BE(records.length, 2);
  table.writeUInt16BE(start, 4);
  let offset = 0;
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    const bytes = strings[index];
    if (!bytes) throw new Error('Missing name fixture string');
    table.writeUInt16BE(record.platform, at);
    table.writeUInt16BE(record.platform === 3 ? 1 : 0, at + 2);
    table.writeUInt16BE(record.platform === 3 ? 0x409 : 0, at + 4);
    table.writeUInt16BE(record.id ?? 6, at + 6);
    table.writeUInt16BE(bytes.length, at + 8);
    table.writeUInt16BE(offset, at + 10);
    bytes.copy(table, start + offset);
    offset += bytes.length;
  });
  return table;
}

function sfnt(table: Buffer, flavor = 0x00010000): Buffer {
  const header = Buffer.alloc(28);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(16, 6);
  header.write('name', 12, 'ascii');
  header.writeUInt32BE(header.length, 20);
  header.writeUInt32BE(table.length, 24);
  return Buffer.concat([header, table]);
}

function woff(table: Buffer, compressed: boolean): Buffer {
  const data = compressed ? deflateSync(table) : table;
  const header = Buffer.alloc(64);
  header.write('wOFF', 0, 'ascii');
  header.writeUInt32BE(0x00010000, 4);
  const padding = Buffer.alloc((4 - (data.length % 4)) % 4);
  header.writeUInt32BE(header.length + data.length + padding.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(28 + ((table.length + 3) & ~3), 16);
  header.write('name', 44, 'ascii');
  header.writeUInt32BE(header.length, 48);
  header.writeUInt32BE(data.length, 52);
  header.writeUInt32BE(table.length, 56);
  return Buffer.concat([header, data, padding]);
}

function base128(value: number): number[] {
  const bytes = [value & 127];
  for (
    let rest = Math.floor(value / 128);
    rest;
    rest = Math.floor(rest / 128)
  ) {
    bytes.unshift((rest & 127) | 128);
  }
  return bytes;
}

function woff2(
  table: Buffer,
  outputLength: number,
  declaredLength = outputLength,
): Buffer {
  const stream = Buffer.alloc(outputLength);
  table.copy(stream);
  const compressed = brotliCompressSync(stream, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 0 },
  });
  // Untransformed 'name' followed by 'cmap' padding, both known table tags.
  const directory = Buffer.from([
    5,
    ...base128(table.length),
    0,
    ...base128(declaredLength - table.length),
  ]);
  const header = Buffer.alloc(48);
  header.write('wOF2');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + directory.length + compressed.length, 8);
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, directory, compressed]);
}

test('rejects WOFF name-table decompression beyond 1 MiB while accepting the exact boundary', () => {
  const table = Buffer.alloc(1024 * 1024 + 1);
  nameTable([{ platform: 3, name: 'Bounded-WOFF' }]).copy(table);
  expect(postScriptName(woff(table.subarray(0, -1), true))).toBe(
    'Bounded-WOFF',
  );
  expect(postScriptName(woff(table, true))).toBeUndefined();
});

test.each([-1, 1])(
  'rejects WOFF inflated length differing from its declaration by %s byte without throwing',
  delta => {
    const font = woff(nameTable([{ platform: 3, name: 'Wrong-Length' }]), true);
    font.writeUInt32BE(font.readUInt32BE(56) + delta, 56);
    expect(postScriptName(font)).toBeUndefined();
  },
);

test('rejects WOFF2 declared stored-table totals beyond 32 MiB while accepting the exact boundary', () => {
  const table = nameTable([{ platform: 3, name: 'Bounded-WOFF2' }]);
  expect(postScriptName(woff2(table, 32 * 1024 * 1024))).toBe('Bounded-WOFF2');
  expect(postScriptName(woff2(table, 32 * 1024 * 1024 + 1))).toBeUndefined();
});

test('rejects a WOFF2 brotli stream that expands beyond its declared stored-table total without throwing', () => {
  const table = nameTable([{ platform: 3, name: 'Hidden-Expansion' }]);
  expect(
    postScriptName(woff2(table, 1024 * 1024, table.length)),
  ).toBeUndefined();
});

test.each([0, 1, 3])(
  'ignores platform %s PostScript records longer than 255 bytes and still reads a later short name',
  platform => {
    const oversized = {
      platform,
      name: 'X'.repeat(platform === 1 ? 256 : 128),
    };
    expect.soft(postScriptName(sfnt(nameTable([oversized])))).toBeUndefined();
    const font = sfnt(nameTable([oversized, { platform, name: 'Short-Name' }]));
    expect(postScriptName(font)).toBe('Short-Name');
  },
);

test('duplicate platform records decode at most one string per platform instead of repeating character work', () => {
  const table = nameTable([{ platform: 3, name: 'A'.repeat(63) }]);
  const count = 512;
  const shared = Buffer.alloc(6 + count * 12 + 126);
  shared.writeUInt16BE(count, 2);
  shared.writeUInt16BE(6 + count * 12, 4);
  for (let i = 0; i < count; i++) table.copy(shared, 6 + i * 12, 6, 18);
  table.copy(shared, 6 + count * 12, 18, 18 + 126);
  const font = sfnt(shared);
  const decodeCharacter = vi.spyOn(String, 'fromCharCode');
  let name: string | undefined;
  let decodedCharacters: number;
  try {
    name = postScriptName(font);
    decodedCharacters = decodeCharacter.mock.calls.length;
  } finally {
    decodeCharacter.mockRestore();
  }
  expect(name).toBe('A'.repeat(63));
  expect(decodedCharacters).toBeLessThanOrEqual(63);
});

test.each([
  '../../../print/public/fonts/LXGWWenKaiTC-Regular.ttf',
  '../../../print/src/test-fixtures/pack-font/report.woff2',
])('decompression and record limits preserve the real font %s', async path => {
  expect(postScriptName(await readFile(new URL(path, import.meta.url)))).toBe(
    'LXGWWenKaiTC-Regular',
  );
});

test.each([
  ['TrueType sfnt', (table: Buffer) => sfnt(table)],
  ['OpenType OTTO', (table: Buffer) => sfnt(table, 0x4f54544f)],
  ['WOFF1 compressed name table', (table: Buffer) => woff(table, true)],
  ['WOFF1 uncompressed name table', (table: Buffer) => woff(table, false)],
] as const)(
  '%s reads nameID 6 and prefers Windows UTF-16BE over earlier fallback records',
  (_format, wrap) => {
    const font = wrap(
      nameTable([
        { platform: 1, name: 'Mac-Fallback' },
        { platform: 0, name: 'Unicode-Fallback' },
        { platform: 3, id: 1, name: 'FamilyName-IsNotPostScript' },
        { platform: 3, name: 'Windows-PostScript' },
      ]),
    );
    expect(postScriptName(font)).toBe('Windows-PostScript');
  },
);

test.each([
  [1, 'MacRoman-Épreuve'],
  [0, 'Unicode-PostScript'],
] as const)(
  'reads platform %s nameID 6 when there is no Windows record',
  (platform, name) => {
    const table = nameTable([{ platform, name }]);
    // Mac Roman encodes É as 0x83, unlike Latin-1's 0xc9.
    if (platform === 1) table[18 + 'MacRoman-'.length] = 0x83;
    expect(postScriptName(sfnt(table))).toBe(name);
  },
);

test('missing nameID 6, placeholder bytes, truncated tables and corrupt WOFF compression return undefined without throwing', () => {
  const valid = sfnt(nameTable([{ platform: 3, name: 'Valid-Name' }]));
  const badOffset = Buffer.from(valid);
  badOffset.writeUInt32BE(0xfffffff0, 20);
  const corruptWoff = woff(
    nameTable([{ platform: 3, name: 'Compressed-Name' }]),
    true,
  );
  corruptWoff.fill(255, 64);
  const invalid = [
    new Uint8Array(),
    Buffer.from('placeholder font, not WOFF2'),
    sfnt(nameTable([{ platform: 3, id: 1, name: 'Only-Family' }])),
    valid.subarray(0, 10),
    valid.subarray(0, 35),
    badOffset,
    corruptWoff,
    Buffer.from('wOF2'),
  ];
  for (const font of invalid) {
    expect(() => postScriptName(font)).not.toThrow();
    expect(postScriptName(font)).toBeUndefined();
  }
});
