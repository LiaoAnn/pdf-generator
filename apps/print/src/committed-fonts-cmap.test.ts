import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { readCmap } from './fonts/sfnt.ts';

const faces = [
  'NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf',
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
  'LXGWWenKaiTC-Regular.ttf',
];

test.each(faces)(
  'committed %s gives every mapped code point its own glyph without deleting printable characters or restoring T03 aliases',
  async name => {
    const mapping = readCmap(
      await readFile(new URL(`../public/fonts/${name}`, import.meta.url)),
    );
    const lxgw = name.startsWith('LXGW');
    const required = lxgw
      ? '⼀一清淸青靑真眞教敎值値溫温刪删宮宫鄉郷尚尙告吿侶侣〈～∙·∼~'
      : '一／∕・·•‧…⋯–‒';
    for (const char of required) {
      expect(
        mapping.get(char.codePointAt(0) as number),
        `${char} must render in ${name}, without fallback`,
      ).toBeGreaterThan(0);
    }
    // T03 drops aliases only when they share a glyph with a non-alias.
    // LXGW's U+2F00 has its own glyph; Noto's shares U+4E00's glyph.
    for (const cp of lxgw ? [0x2329, 0x301c] : [0x2f00]) {
      expect
        .soft(mapping.has(cp), `T03 alias U+${cp.toString(16)} stays absent`)
        .toBe(false);
    }
    // Scalar counts avoid Vitest diffing tens of thousands of cmap entries.
    expect(
      new Set(mapping.values()).size,
      'shared glyphs corrupt Chrome ToUnicode extraction',
    ).toBe(mapping.size);
  },
);
