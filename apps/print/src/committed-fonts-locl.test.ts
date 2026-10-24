import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

// Read the committed binaries independently of the production font patcher.
function table(font: Buffer, tag: string) {
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + 16 * i;
    if (font.toString('ascii', at, at + 4) === tag) {
      const offset = font.readUInt32BE(at + 8);
      return font.subarray(offset, offset + font.readUInt32BE(at + 12));
    }
  }
  throw new Error(`Missing ${tag} table`);
}

function features(gsub: Buffer) {
  const list = gsub.readUInt16BE(6);
  return Array.from({ length: gsub.readUInt16BE(list) }, (_, i) => {
    const at = list + 2 + 6 * i;
    const feature = list + gsub.readUInt16BE(at + 4);
    return {
      tag: gsub.toString('ascii', at, at + 4),
      lookups: Array.from({ length: gsub.readUInt16BE(feature + 2) }, (_, j) =>
        gsub.readUInt16BE(feature + 4 + j * 2),
      ),
    };
  });
}

function digitGlyphs(cmap: Buffer) {
  // The T03 build emits one Windows full-Unicode format-12 subtable.
  const record = Array.from(
    { length: cmap.readUInt16BE(2) },
    (_, i) => 4 + 8 * i,
  ).find(at => cmap.readUInt16BE(at) === 3 && cmap.readUInt16BE(at + 2) === 10);
  if (record === undefined)
    throw new Error('Missing Windows full-Unicode cmap');
  const start = cmap.readUInt32BE(record + 4);
  expect(cmap.readUInt16BE(start)).toBe(12);
  return Array.from({ length: 10 }, (_, digit) => {
    const cp = 0x30 + digit;
    for (let i = 0; i < cmap.readUInt32BE(start + 12); i++) {
      const at = start + 16 + 12 * i;
      const first = cmap.readUInt32BE(at);
      if (cp >= first && cp <= cmap.readUInt32BE(at + 4)) {
        return cmap.readUInt32BE(at + 8) + cp - first;
      }
    }
    throw new Error(`Missing digit U+${cp.toString(16)}`);
  });
}

test.each([
  'NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf',
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
])(
  '%s disables every locl lookup, including every path that could substitute digit glyphs, while preserving vertical substitutions',
  async name => {
    const font = await readFile(
      new URL(`../public/fonts/${name}`, import.meta.url),
    );
    const records = features(table(font, 'GSUB'));
    const locl = records.filter(record => record.tag === 'locl');
    expect(locl.length).toBeGreaterThan(0);
    expect(
      records.some(
        record => record.tag === 'vert' && record.lookups.length > 0,
      ),
    ).toBe(true);
    const digits = digitGlyphs(table(font, 'cmap'));
    expect(digits.every(glyph => glyph > 0)).toBe(true);
    // No first lookup means no reachable substitution of any of U+0030–0039,
    // including through contextual or extension lookup chains. Checking each
    // record also catches a build that patches only one language's locl.
    for (const [i, feature] of locl.entries()) {
      expect(
        feature.lookups,
        `locl record ${i}; digit glyphs ${digits.join(',')}`,
      ).toEqual([]);
    }
  },
);
