// A string under n nested @imports loads n times in Paged.js 0.4.3, so
// `@import "x.css" {` nested n deep loads n(n+1)/2 times, and reading them
// one by one made a 20.7 KiB sheet cost 661,825 loads and over a second of
// the upload check's CPU (T06-19). pagedImports reports each string once,
// with the number of times Paged.js loads it, in work linear in the sheet
// whatever the nesting.
import { describe, expect, it } from 'vitest';
import { pagedImports, pagedImportWork } from './paged-imports.ts';
import { fullPagedImports } from './paged-imports-full.test-support.ts';

/**
 * The T06-17 walk's loads as pagedImports reports them: each string once,
 * where Paged.js first loads it, with how many times it loads it.
 */
function grouped(loads: { url: string; offset: number }[]) {
  const strings = new Map<
    number,
    { url: string; offset: number; loads: number }
  >();
  for (const { url, offset } of loads) {
    const string = strings.get(offset);
    if (string === undefined) strings.set(offset, { url, offset, loads: 1 });
    else string.loads++;
  }
  return [...strings.values()];
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
 * strings sit under many @imports.
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

describe('pagedImports on generated sheets', () => {
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

  it('reads each string Paged.js loads once, in its order, with its load count', () => {
    let twice = 0;
    let four = 0;
    let seven = 0;
    for (const css of sheets) {
      const loads = grouped(fullPagedImports(css));
      const most = Math.max(0, ...loads.map(load => load.loads));
      if (most > 1) twice++;
      if (most > 3) four++;
      if (most > 6) seven++;
      expect(pagedImports(css), css).toEqual(loads);
    }
    // The generated sheets do nest strings under several @imports.
    expect(twice).toBeGreaterThan(100);
    expect(four).toBeGreaterThan(50);
    expect(seven).toBeGreaterThan(20);
  });
});

/** Most the walk may count per character of the sheet. */
const linear = 6;

/** 1 + 2 + … + n. */
const triangle = (n: number) => (n * (n + 1)) / 2;

describe('pagedImports on nested @import blocks: linear work', () => {
  it.each<{
    name: string;
    css: (n: number) => string;
    strings: (n: number) => number;
    loads: (n: number) => number;
  }>([
    {
      // The k-th @import's own string sits under k @imports.
      name: '@import "x.css" { nested',
      css: n => chain(n, '@import "x.css" {'),
      strings: n => n,
      loads: triangle,
    },
    {
      name: '@import { nested around one string',
      css: n => chain(n, '@import {', 'p{content:"x.css"}'),
      strings: () => 1,
      loads: n => n,
    },
    {
      // A screen query under every @import: Paged.js loads none of them,
      // and the old check walked each @import's subtree to find out.
      name: '@import "x.css" { nested around a screen query',
      css: n => chain(n, '@import "x.css" {', '@media screen{}'),
      strings: () => 0,
      loads: () => 0,
    },
    {
      // Only the outermost @import is skipped.
      name: '@import "x.css" { nested inside a screen @import',
      css: n => `@import "s.css" screen {${chain(n, '@import "x.css" {')}}`,
      strings: n => n,
      loads: triangle,
    },
  ])('reads $name in linear work', ({ css, strings, loads }) => {
    // Past about 1,000 levels css-tree's recursive walker can run out of
    // stack (import-counts-check.test.ts).
    for (const n of [100, 250, 500]) {
      const text = css(n);
      const before = pagedImportWork.walked;
      const loaded = pagedImports(text);
      const walked = pagedImportWork.walked - before;

      expect(loaded.length).toBe(strings(n));
      expect(loaded.reduce((sum, load) => sum + load.loads, 0)).toBe(loads(n));
      expect(loaded.every(load => load.url === 'x.css')).toBe(true);
      // The counter sees the walk: at least one per @import and per string.
      expect(walked).toBeGreaterThanOrEqual(n + loaded.length);
      expect(walked / text.length, `n = ${n}`).toBeLessThanOrEqual(linear);
    }
  });
});
