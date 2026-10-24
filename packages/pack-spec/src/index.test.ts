import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wordCss } from './index.ts';

// Read declarations rather than snapshotting CSS formatting or selector names.
function declarations(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)].map(match => [
      (match[1] ?? '').toLowerCase(),
      (match[2] ?? '').trim().toLowerCase(),
    ]),
  );
}

function defaultPage(css: string): string {
  const opening = /@page\s*\{/i.exec(css);
  expect(opening, 'a default @page rule is required').not.toBeNull();
  let depth = 1;
  let body = '';
  // Ignore nested margin boxes: their declarations do not set page geometry.
  for (const character of css.slice(
    (opening?.index ?? 0) + (opening?.[0].length ?? 0),
  )) {
    if (character === '{') depth++;
    if (character === '}') depth--;
    if (depth === 0) return body;
    if (depth === 1) body += character === '}' ? ';' : character;
  }
  throw new Error('unclosed @page rule');
}

function millimetres(value: string): number {
  const match = /^(\d*\.?\d+)(mm|cm|in|pt|px)$/.exec(value);
  expect(match, `expected a physical page length, got ${value}`).not.toBeNull();
  const factors: Record<string, number> = {
    mm: 1,
    cm: 10,
    in: 25.4,
    pt: 25.4 / 72,
    px: 25.4 / 96,
  };
  return Number(match?.[1]) * (factors[match?.[2] ?? ''] ?? Number.NaN);
}

describe('canonical Word stylesheet', () => {
  it('exposes the canonical stylesheet bytes that pack authors copy', () => {
    const css = wordCss();
    expect(css.trim().length).toBeGreaterThan(0);
    expect(css).toBe(
      readFileSync(new URL('../word.css', import.meta.url), 'utf8'),
    );
  });

  it('preserves A4 portrait and Word zh-TW default margins for reference-document alignment', () => {
    const css = wordCss().replace(/\/\*[\s\S]*?\*\//g, '');
    const values = declarations(defaultPage(css));
    const size = (values.get('size') ?? '').split(/\s+/);
    if (size.includes('a4')) {
      expect(size.filter(token => token !== 'portrait')).toEqual(['a4']);
    } else {
      const lengths = size.filter(token => token !== 'portrait');
      expect(lengths).toHaveLength(2);
      expect(millimetres(lengths[0] ?? '')).toBeCloseTo(210, 1);
      expect(millimetres(lengths[1] ?? '')).toBeCloseTo(297, 1);
    }
    const shorthand = (values.get('margin') ?? '').split(/\s+/);
    const expanded = [
      shorthand[0],
      shorthand[1] ?? shorthand[0],
      shorthand[2] ?? shorthand[0],
      shorthand[3] ?? shorthand[1] ?? shorthand[0],
    ];
    for (const [index, side] of ['top', 'right', 'bottom', 'left'].entries()) {
      const value = values.get(`margin-${side}`) ?? expanded[index] ?? '';
      expect(millimetres(value), `${side} margin`).toBeCloseTo(
        index % 2 === 0 ? 25.4 : 31.7,
        1,
      );
    }
  });
});
