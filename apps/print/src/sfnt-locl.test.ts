import { expect, test } from 'vitest';

function words(...values: number[]) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => {
    bytes.writeUInt16BE(value, i * 2);
  });
  return bytes;
}

function checksum(bytes: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum =
      (sum +
        (bytes[i] ?? 0) * 0x1000000 +
        (bytes[i + 1] ?? 0) * 0x10000 +
        (bytes[i + 2] ?? 0) * 0x100 +
        (bytes[i + 3] ?? 0)) >>>
      0;
  }
  return sum;
}

function directory(font: Buffer) {
  return Array.from({ length: font.readUInt16BE(4) }, (_, i) => {
    const entry = 12 + 16 * i;
    return {
      tag: font.toString('ascii', entry, entry + 4),
      entry,
      offset: font.readUInt32BE(entry + 8),
      length: font.readUInt32BE(entry + 12),
    };
  });
}

function gsub(withLocl: boolean) {
  // DFLT/default LangSys references all five feature records.
  const scripts = Buffer.concat([
    words(1),
    Buffer.from('DFLT'),
    words(8),
    words(4, 0),
    words(0, 0xffff, 5, 0, 1, 2, 3, 4),
  ]);
  // Two locl records share a Feature table; another has a distinct table;
  // the fourth is already a no-op. vert must keep both lookup indices.
  const records = Buffer.alloc(32);
  records.writeUInt16BE(5);
  [32, 32, 40, 46, 50].forEach((offset, i) => {
    records.write(i === 4 ? 'vert' : withLocl ? 'locl' : 'liga', 2 + i * 6);
    records.writeUInt16BE(offset, 6 + i * 6);
  });
  const features = Buffer.concat([
    records,
    words(0, 2, 0, 1),
    words(0, 1, 1),
    words(0, 0),
    words(0, 2, 1, 0),
  ]);
  // Two valid SingleSubst lookups with format-1 coverage tables.
  const lookup = (glyph: number) => words(1, 0, 1, 8, 1, 6, 1, 1, 1, glyph);
  const lookups = Buffer.concat([words(2, 6, 26), lookup(10), lookup(11)]);
  return Buffer.concat([
    words(1, 0, 10, 10 + scripts.length, 10 + scripts.length + features.length),
    scripts,
    features,
    lookups,
  ]);
}

function fixture(mode: 'locl' | 'other' | 'absent' = 'locl') {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  const tables: [string, Buffer][] = [
    ['hmtx', words(500, 0, 600, 1)],
    ['head', head],
    ['cmap', Buffer.concat([words(0, 0), Buffer.from([0x91, 0x82, 0x73])])],
    ...(mode === 'absent'
      ? []
      : [['GSUB', gsub(mode === 'locl')] satisfies [string, Buffer]]),
    ['CFF ', Buffer.from([1, 0, 4, 4, 0, 0, 0])],
    ['maxp', Buffer.from([0, 0, 0x50, 0, 0, 100])],
  ];
  const header = Buffer.alloc(12 + 16 * tables.length);
  header.write('OTTO');
  header.writeUInt16BE(tables.length, 4);
  header.writeUInt16BE(64, 6);
  header.writeUInt16BE(2, 8);
  header.writeUInt16BE(tables.length * 16 - 64, 10);
  let offset = header.length;
  const bodies: Buffer[] = [];
  tables.forEach(([tag, data], i) => {
    header.write(tag, 12 + 16 * i);
    header.writeUInt32BE(checksum(data), 16 + 16 * i);
    header.writeUInt32BE(offset, 20 + 16 * i);
    header.writeUInt32BE(data.length, 24 + 16 * i);
    // A nonzero aligned gap after zero padding detects accidental rebuilding.
    const padding = Buffer.concat([
      Buffer.alloc((4 - (data.length % 4)) % 4),
      Buffer.alloc(4, 0xa5),
    ]);
    bodies.push(data, padding);
    offset += data.length + padding.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headAt = directory(font).find(t => t.tag === 'head')?.offset;
  if (headAt === undefined) throw new Error('fixture lacks head');
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

type DisableLocl = (font: Uint8Array) => { font: Uint8Array; features: number };
async function patcher(): Promise<DisableLocl> {
  // Runtime lookup lets the RED suite load and typecheck before the export exists.
  const module: Record<string, unknown> = await import('./fonts/sfnt.ts');
  expect(module.disableLocl, 'sfnt.ts must export disableLocl').toBeTypeOf(
    'function',
  );
  return module.disableLocl as DisableLocl;
}

function featureCounts(font: Buffer) {
  const table = directory(font).find(t => t.tag === 'GSUB');
  if (!table) throw new Error('fixture lacks GSUB');
  const list = table.offset + font.readUInt16BE(table.offset + 6);
  return Array.from(
    { length: font.readUInt16BE(list) },
    (_, i) => list + font.readUInt16BE(list + 6 + i * 6) + 2,
  );
}

test('disables every locl record including shared tables without moving tables or changing unrelated bytes, and repairs both checksums', async () => {
  const disableLocl = await patcher();
  const original = fixture();
  // Exercise a Uint8Array with a nonzero byteOffset as well as input immutability.
  const backing = new Uint8Array(original.length + 13).fill(0xcc);
  backing.set(original, 7);
  const before = backing.slice();
  const result = disableLocl(backing.subarray(7, 7 + original.length));
  expect(backing).toEqual(before);
  expect(result.features).toBe(4);
  const output = Buffer.from(result.font);
  const counts = featureCounts(output);
  expect(counts.map(at => output.readUInt16BE(at))).toEqual([0, 0, 0, 0, 2]);

  const expected = Buffer.from(original);
  for (const at of featureCounts(original).slice(0, 4))
    expected.writeUInt16BE(0, at);
  const tables = directory(expected);
  const gsub = tables.find(t => t.tag === 'GSUB');
  const head = tables.find(t => t.tag === 'head');
  if (!gsub || !head) throw new Error('fixture lacks required tables');
  expected.writeUInt32BE(
    checksum(expected.subarray(gsub.offset, gsub.offset + gsub.length)),
    gsub.entry + 4,
  );
  expected.writeUInt32BE(0, head.offset + 8);
  expected.writeUInt32BE(
    (0xb1b0afba - checksum(expected)) >>> 0,
    head.offset + 8,
  );
  // Full equality pins order, offsets, lengths, padding, scripts, lookup data,
  // old lookup-index bytes and every non-GSUB table (except the head adjustment).
  expect(output).toEqual(expected);
  for (const table of directory(output)) {
    const bytes = Buffer.from(
      output.subarray(table.offset, table.offset + table.length),
    );
    if (table.tag === 'head') bytes.writeUInt32BE(0, 8);
    expect(output.readUInt32BE(table.entry + 4), `${table.tag} checksum`).toBe(
      checksum(bytes),
    );
  }
  expect(checksum(output)).toBe(0xb1b0afba);
});

test('counts already-disabled locl records and leaves a second patch byte-identical', async () => {
  const disableLocl = await patcher();
  const first = disableLocl(fixture());
  const second = disableLocl(first.font);
  expect(second.features).toBe(4);
  expect(Buffer.from(second.font)).toEqual(Buffer.from(first.font));
});

test.each([
  { mode: 'absent', reason: 'no GSUB table' },
  { mode: 'other', reason: 'GSUB with no locl records' },
] as const)(
  'returns byte-identical bytes and zero features for a font with $reason',
  async ({ mode }) => {
    const disableLocl = await patcher();
    const source = fixture(mode);
    const before = Buffer.from(source);
    const result = disableLocl(source);
    expect(result.features).toBe(0);
    expect(Buffer.from(result.font)).toEqual(before);
    expect(source).toEqual(before);
  },
);
