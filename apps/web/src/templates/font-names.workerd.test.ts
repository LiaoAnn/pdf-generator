import { Buffer } from 'node:buffer';
import { brotliCompressSync, constants, deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { postScriptName } from './font-names.ts';

const fontName = 'Runtime-PostScript';

// A Windows nameID 6 followed by padding: the name record itself stays small
// even when the table or WOFF2's complete table stream is large.
function nameTable(length: number): Buffer {
  const table = Buffer.alloc(length);
  const text = Buffer.from(fontName, 'utf16le').swap16();
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(18, 4);
  table.writeUInt16BE(3, 6);
  table.writeUInt16BE(1, 8);
  table.writeUInt16BE(0x409, 10);
  table.writeUInt16BE(6, 12);
  table.writeUInt16BE(text.length, 14);
  text.copy(table, 18);
  return table;
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

function woff(length: number, declaredLength = length): Buffer {
  const data = deflateSync(nameTable(length));
  const header = Buffer.alloc(64);
  const padding = Buffer.alloc((4 - (data.length % 4)) % 4);
  header.write('wOFF');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + data.length + padding.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(28 + Math.ceil(declaredLength / 4) * 4, 16);
  header.write('name', 44);
  header.writeUInt32BE(header.length, 48);
  header.writeUInt32BE(data.length, 52);
  header.writeUInt32BE(declaredLength, 56);
  return Buffer.concat([header, data, padding]);
}

function woff2(length: number, declaredLength = length): Buffer {
  const stream = Buffer.alloc(length);
  nameTable(256).copy(stream);
  const data = brotliCompressSync(stream, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 0 },
  });
  // Known tags: untransformed name (5), followed by cmap (0) padding.
  const directory = Buffer.from([
    5,
    ...base128(256),
    0,
    ...base128(declaredLength - 256),
  ]);
  const header = Buffer.alloc(48);
  header.write('wOF2');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + directory.length + data.length, 8);
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(12 + 32 + Math.ceil(declaredLength / 4) * 4, 16);
  header.writeUInt32BE(data.length, 20);
  return Buffer.concat([header, directory, data]);
}

const formats = [
  { format: 'WOFF', wrap: woff, cap: 1024 * 1024 },
  { format: 'WOFF2', wrap: woff2, cap: 32 * 1024 * 1024 },
];

describe('slice 1: workerd decompression safeguards', () => {
  test.each(formats)('$format reads a small compressed font', ({ wrap }) => {
    expect(postScriptName(wrap(512))).toBe(fontName);
  });

  test.each(formats)(
    '$format rejects output beyond the declared length and charges the declaration',
    ({ wrap }) => {
      // Both lengths fit the same output buffer. This catches losing the
      // exact-length check even if zlib still enforces its rounded limit.
      const budget = { bytes: 2048 };
      expect(postScriptName(wrap(514, 513), budget)).toBeUndefined();
      expect(budget.bytes).toBe(1535);
      // Also force expansion beyond the rounded output allowance.
      expect(postScriptName(wrap(128 * 1024, 513), budget)).toBeUndefined();
      expect(budget.bytes).toBe(1022);
    },
  );

  test.each(formats)(
    '$format rejects oversized declarations before spending the shared budget',
    ({ wrap, cap }) => {
      const budget = { bytes: cap + 1 };
      expect(postScriptName(wrap(512, cap + 1), budget)).toBeUndefined();
      expect(budget.bytes).toBe(cap + 1);
    },
  );

  test.each(formats)(
    '$format charges successful reads and refuses a later font that exceeds the remaining budget',
    ({ wrap }) => {
      const font = wrap(512);
      const budget = { bytes: 1023 };
      expect(postScriptName(font, budget)).toBe(fontName);
      expect(budget.bytes).toBe(511);
      expect(postScriptName(font, budget)).toBeUndefined();
      expect(budget.bytes).toBe(511);
      expect(postScriptName(font, { bytes: 512 })).toBe(fontName);
    },
  );
});

describe('slice 2: workerd large decompression', () => {
  test('WOFF2 reads large table streams including exact 40,960-byte multiples and powers of two', () => {
    // The final two sizes already work: retain them so a fix cannot round to
    // an insufficient buffer at exact chunk or power-of-two boundaries.
    for (const length of [40_961, 42_926, 65_535, 81_920, 131_072]) {
      expect
        .soft(postScriptName(woff2(length)), `${length} bytes`)
        .toBe(fontName);
    }
  });

  test('WOFF reads a compressed name table inflating to 42,926 bytes', () => {
    expect(postScriptName(woff(42_926))).toBe(fontName);
  });
});
