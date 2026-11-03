// The font build splits a platform font Chrome's batch cache can't keep
// (over 6.25 MiB, T07-37) into unicode-range chunks it can, without changing
// what any code point prints: same glyph metrics, layout tables, vertical
// metrics and PostScript name (the self-check's allowed fonts).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { beforeAll, expect, test } from 'vitest';
import { readCmap } from './fonts/sfnt.ts';
import { splitFont } from './fonts/split.ts';
import { fontTables, metrics } from './test-fixtures/read-cff.ts';

// Under the 6 MiB chunk limit and not split by the platform; a real CFF font
// the size of the ones that are.
const name = 'NotoSansTC-Regular.otf';
let source: Uint8Array;

beforeAll(async () => {
  source = new Uint8Array(
    await readFile(new URL(`../public/fonts/${name}`, import.meta.url)),
  );
});

/** Code point ranges of a CSS unicode-range value (`U+0-33FF, U+4DC0`). */
function ranges(unicodeRange: string): [number, number][] {
  return unicodeRange.split(',').map(part => {
    const match = /^\s*U\+([0-9A-F]+)(?:-([0-9A-F]+))?\s*$/i.exec(part);
    if (!match) throw new Error(`bad unicode-range part ${part}`);
    const start = Number.parseInt(match[1] as string, 16);
    return [start, Number.parseInt(match[2] ?? (match[1] as string), 16)];
  });
}

const inRanges = (cp: number, list: [number, number][]) =>
  list.some(([start, end]) => cp >= start && cp <= end);

const table = (font: Uint8Array, tag: string) => {
  const found = fontTables(font).get(tag);
  if (!found) throw new Error(`no ${tag} table`);
  return found.bytes;
};

/** Advance width of each mapped code point. */
function advances(font: Uint8Array): Map<number, number> {
  const glyphs = table(font, 'maxp').readUInt16BE(4);
  const widths = metrics(table(font, 'hmtx'), table(font, 'hhea'), glyphs);
  return new Map(
    [...readCmap(font)].map(([cp, gid]) => [cp, widths[gid]?.[0] ?? -1]),
  );
}

/** The Windows-platform PostScript name (name ID 6). */
function postScriptName(font: Uint8Array): string | undefined {
  const names = table(font, 'name');
  const count = names.readUInt16BE(2);
  const strings = names.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const at = 6 + 12 * i;
    if (names.readUInt16BE(at) !== 3 || names.readUInt16BE(at + 6) !== 6) {
      continue;
    }
    const length = names.readUInt16BE(at + 8);
    const offset = strings + names.readUInt16BE(at + 10);
    return names
      .subarray(offset, offset + length)
      .swap16()
      .toString('utf16le');
  }
  return undefined;
}

/** hhea ascender/descender/lineGap and OS/2 typo and win metrics. */
function verticalMetrics(font: Uint8Array): number[] {
  const hhea = table(font, 'hhea');
  const os2 = table(font, 'OS/2');
  return [
    hhea.readInt16BE(4),
    hhea.readInt16BE(6),
    hhea.readInt16BE(8),
    os2.readInt16BE(68),
    os2.readInt16BE(70),
    os2.readInt16BE(72),
    os2.readUInt16BE(74),
    os2.readUInt16BE(76),
  ];
}

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// Regression: chunks that overlap or leave a gap make Chrome pick a chunk
// without the glyph (fallback font) or none; a chunk missing one of the
// source's code points prints it in a fallback font; one carrying another
// chunk's code points loads it twice.
test('splits a font into four chunks whose unicode-ranges partition Unicode and whose cmaps partition the source', async () => {
  const chunks = await splitFont(source, name);
  expect(chunks.map(chunk => [chunk.file, chunk.unicodeRange])).toEqual([
    [
      'NotoSansTC-Regular.part0.otf',
      'U+0-33FF, U+4DC0-4DFF, U+A000-F8FF, U+FB00-1FFFF, U+40000-10FFFF',
    ],
    ['NotoSansTC-Regular.part1.otf', 'U+3400-4DBF, U+4E00-69FF'],
    ['NotoSansTC-Regular.part2.otf', 'U+6A00-87FF'],
    ['NotoSansTC-Regular.part3.otf', 'U+8800-9FFF, U+F900-FAFF, U+20000-3FFFF'],
  ]);
  const declared = chunks.map(chunk => ranges(chunk.unicodeRange));
  const sorted = declared.flat().sort((a, b) => a[0] - b[0]);
  let next = 0;
  for (const [start, end] of sorted) {
    expect(start, 'ranges are contiguous and disjoint').toBe(next);
    next = end + 1;
  }
  expect(next).toBe(0x110000);

  const all = readCmap(source);
  let mapped = 0;
  chunks.forEach((chunk, i) => {
    const cmap = readCmap(chunk.font);
    const own = declared[i] as [number, number][];
    const expected = [...all.keys()].filter(cp => inRanges(cp, own));
    // Scalar counts: no Vitest diff of tens of thousands of entries.
    expect(cmap.size, `${chunk.file} code points`).toBe(expected.length);
    expect(
      expected.filter(cp => !cmap.has(cp)).length,
      `${chunk.file} misses source code points of its range`,
    ).toBe(0);
    expect(
      new Set(cmap.values()).size,
      `${chunk.file}: every code point keeps its own glyph (T07-13)`,
    ).toBe(cmap.size);
    mapped += cmap.size;
  });
  expect(mapped).toBe(all.size);
});

// Regression: a subsetter that rebuilds metrics or drops layout tables
// (pure-JS ones drop GSUB/GPOS) moves glyphs and line boxes, so gt.json
// changes; another PostScript name fails the self-check's font list.
test('keeps every code point’s advance width, the layout tables, the vertical metrics and the PostScript name', async () => {
  const chunks = await splitFont(source, name);
  const before = advances(source);
  const sourceTags = [...fontTables(source).keys()].sort();
  for (const chunk of chunks) {
    const after = advances(chunk.font);
    const changed = [...after].filter(
      ([cp, width]) => before.get(cp) !== width,
    );
    expect(changed.length, `${chunk.file} advance widths changed`).toBe(0);
    const tags = [...fontTables(chunk.font).keys()];
    expect(tags, chunk.file).toEqual(expect.arrayContaining(['GSUB', 'GPOS']));
    expect(verticalMetrics(chunk.font), chunk.file).toEqual(
      verticalMetrics(source),
    );
    expect(postScriptName(chunk.font), chunk.file).toBe(postScriptName(source));
  }
  // The chunk with Latin, punctuation and marks keeps every table, GDEF's
  // mark and ligature classes included.
  expect([...fontTables(chunks[0]?.font ?? source).keys()].sort()).toEqual(
    sourceTags,
  );
});

// Regression: the committed fonts must rebuild byte for byte (AGENTS.md
// "Determinism").
test('is deterministic', async () => {
  const first = (await splitFont(source, name)).map(chunk => sha(chunk.font));
  const second = (await splitFont(source, name)).map(chunk => sha(chunk.font));
  expect(second).toEqual(first);
});

// Regression: a chunk over the limit would be committed and reload every
// print again, silently.
test('refuses a chunk at or over the size limit, naming it', async () => {
  await expect(
    splitFont(source, name, { maxBytes: 1024 * 1024 }),
  ).rejects.toThrow(/NotoSansTC-Regular\.part[123]\.otf/);
});
