// A string under n nested @imports loads n times in Paged.js 0.4.3, so
// `@import "x.css" {` nested n deep loads n(n+1)/2 times, and reading them
// one by one made a 20.7 KiB sheet cost 661,825 loads and over a second of
// the upload check's CPU (T06-19). The check only needs each string's loads
// up to just past the 64-load limit: pagedImports takes a limit and drops
// the rest, and its walk is linear in the sheet whatever the nesting.
import { describe, expect, it } from 'vitest';
import {
  type PagedImport,
  pagedImports,
  pagedImportWork,
} from './paged-imports.ts';
import { fullPagedImports } from './paged-imports-full.test-support.ts';

/** `loads` with every load of a string past its `limit`-th dropped. */
function keepFirst(loads: PagedImport[], limit: number): PagedImport[] {
  const seen = new Map<number, number>();
  return loads.filter(({ offset }) => {
    const count = (seen.get(offset) ?? 0) + 1;
    seen.set(offset, count);
    return count <= limit;
  });
}

/** A small seeded generator (mulberry32), so every run reads the same sheets. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blocks that open a level: @imports read and skipped, and other at-rules. */
const openers = [
  '@import "a.css" {',
  '@import url("b.css") print {',
  '@import {',
  '@-webkit-import "w.css" {',
  '@import "s.css" screen {',
  '@import "v.css" speech {',
  '@import "n.css" not print {',
  '@import "o.css" (orientation: portrait) {',
  '@media screen {',
  '@media print {',
  '@supports (display: grid) {',
  // `not`, screen and speech outside a media query skip no @import.
  '@supports not (display: grid) {',
  'p{',
];
/** What sits inside a level: strings Paged.js loads under an @import, and not. */
const leaves = [
  '@import "l.css";',
  '@import "m.css" screen;',
  '@import url(u.css);',
  '@import "";',
  'p{content:"c.css"}',
  '#i{}',
  'p{content:element("e.css")}',
  'q{a:element(x)}',
  '@media not print{}',
  '@media screen{}',
  'p{color:#abc}',
  'p{a:screen not speech}',
];

/** A sheet of nested blocks, some left unclosed, from `seed`. */
function sheet(seed: number): string {
  const next = random(seed);
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)] as T;
  const level = (depth: number): string => {
    let css = '';
    const count = Math.floor(next() * 4);
    for (let i = 0; i < count; i++) {
      if (depth < 7 && next() < 0.6) {
        css += pick(openers) + level(depth + 1) + (next() < 0.95 ? '}' : '');
      } else css += pick(leaves);
    }
    return css;
  };
  return level(0) || pick(leaves);
}

/** @import blocks Paged.js reads whatever they hold, but for a screen query. */
const importOpeners = openers.filter(
  opener => opener.includes('import') && !/screen|speech|not/.test(opener),
);

/**
 * A sheet from `seed` inside 3 to 10 more blocks, most of them @imports, so
 * strings sit under more @imports than the limits below.
 */
function deepSheet(seed: number): string {
  const next = random(seed + 1_000_000);
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)] as T;
  let css = sheet(seed);
  const levels = 3 + Math.floor(next() * 8);
  for (let i = 0; i < levels; i++) {
    css = `${pick(next() < 0.8 ? importOpeners : openers)}${css}}`;
  }
  return css;
}

/** A chain of `depth` opener blocks around `inner`. */
const chain = (depth: number, opener: string, inner = '') =>
  opener.repeat(depth) + inner + '}'.repeat(depth);

describe('pagedImports with a limit', () => {
  const sheets = [
    ...Array.from({ length: 400 }, (_, seed) => sheet(seed)),
    ...Array.from({ length: 400 }, (_, seed) => deepSheet(seed)),
    chain(9, '@import "x.css" {'),
    chain(9, '@import {', 'p{content:"x.css"}'),
    chain(9, '@import "x.css" {', '@media screen{}'),
    `@import "s.css" screen {${chain(9, '@import "x.css" {')}}`,
    chain(9, '@import "x.css" {', '@media not print{}@import "y.css";'),
    chain(5, '@import "x.css" {', chain(5, '@media print {', '"in.css"')),
  ];

  it('reads what Paged.js loads, in its order, without a limit', () => {
    let nested = 0;
    for (const css of sheets) {
      const loads = fullPagedImports(css);
      if (keepFirst(loads, 1).length < loads.length) nested++;
      expect(pagedImports(css), css).toEqual(loads);
    }
    // The generated sheets do nest strings under several @imports.
    expect(nested).toBeGreaterThan(100);
  });

  it.each([1, 2, 3, 5])(
    "drops each string's loads past the %i-th and keeps the rest in order",
    limit => {
      let dropped = 0;
      for (const css of sheets) {
        const loads = fullPagedImports(css);
        const kept = keepFirst(loads, limit);
        if (kept.length < loads.length) dropped++;
        expect(pagedImports(css, limit), css).toEqual(kept);
      }
      expect(dropped).toBeGreaterThan(20);
    },
  );
});

/** The limit the upload check needs: just past 64 loads (T06-7). */
const limit = 66;
/** Most the bounded walk may count per character of the sheet. */
const linear = 6;

/** 1 + 2 + … + n, each term capped at `limit`. */
const cappedSum = (n: number) => {
  let sum = 0;
  for (let k = 1; k <= n; k++) sum += Math.min(k, limit);
  return sum;
};

describe('pagedImports on nested @import blocks: linear work', () => {
  it.each<{
    name: string;
    css: (n: number) => string;
    loads: (n: number) => number;
  }>([
    {
      // The k-th @import's own string sits under k @imports.
      name: '@import "x.css" { nested',
      css: n => chain(n, '@import "x.css" {'),
      loads: cappedSum,
    },
    {
      name: '@import { nested around one string',
      css: n => chain(n, '@import {', 'p{content:"x.css"}'),
      loads: n => Math.min(n, limit),
    },
    {
      // A screen query under every @import: Paged.js loads none of them,
      // and the old check walked each @import's subtree to find out.
      name: '@import "x.css" { nested around a screen query',
      css: n => chain(n, '@import "x.css" {', '@media screen{}'),
      loads: () => 0,
    },
    {
      // Only the outermost @import is skipped.
      name: '@import "x.css" { nested inside a screen @import',
      css: n => `@import "s.css" screen {${chain(n, '@import "x.css" {')}}`,
      loads: cappedSum,
    },
  ])('reads $name in linear work', ({ css, loads }) => {
    // Past about 1,000 levels css-tree's recursive walker can run out of
    // stack (import-limit-check.test.ts).
    for (const n of [100, 250, 500]) {
      const text = css(n);
      const before = pagedImportWork.walked;
      const loaded = pagedImports(text, limit);
      const walked = pagedImportWork.walked - before;

      expect(loaded.length).toBe(loads(n));
      expect(loaded.every(load => load.url === 'x.css')).toBe(true);
      // The counter sees the walk: at least one per @import and per load.
      expect(walked).toBeGreaterThanOrEqual(n + loaded.length);
      expect(walked / text.length, `n = ${n}`).toBeLessThanOrEqual(linear);
    }
  });
});
