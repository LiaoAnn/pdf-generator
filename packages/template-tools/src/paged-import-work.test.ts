// The offset mapping in pagedImports, counted instead of timed: every
// stylesheet an upload reads goes through it, and mapping each @import's
// offset back through the element() rewrites by rereading every earlier
// rewrite is O(rewrites × imports): 61 KiB of `a{--x:element(x);}` and
// @imports read 3.24 M rewrites (T06-15's Security lens). A linear mapping
// reads each rewrite a few times; that one reads each thousands of times.
import { describe, expect, it } from 'vitest';
import { pagedImports, pagedImportWork } from './paged-imports.ts';

const size = 64 * 1024;
/** `unit` repeated to just under `bytes` (64 KiB by default). */
const fill = (unit: string, bytes = size) =>
  unit.repeat(Math.floor(bytes / unit.length));

/**
 * Most a linear mapping may read per character of the sheet. Precomputing
 * the spans reads each rewrite once; a binary search per @import reads
 * about 12 of these ≈2,000 rewrites, under 1 per character on these
 * shapes. Rereading every earlier rewrite per @import reads 25 to 65 per
 * character here.
 */
const linear = 4;

/** Offsets just past the quote of every `"x.css"` in `css`. */
const quoted = (css: string) => {
  const offsets: number[] = [];
  for (
    let at = css.indexOf('"x.css"');
    at >= 0;
    at = css.indexOf('"x.css"', at + 1)
  )
    offsets.push(at + 1);
  return offsets;
};

const rule = 'a{--x:element(x);}';
const half = size / 2;

describe('pagedImports offset mapping: linear in the stylesheet', () => {
  it.each<{ name: string; css: string; loadsEach?: number }>([
    {
      name: 'element() rules, then imports',
      css: fill(rule, half) + fill('@import "x.css";', half),
    },
    {
      name: 'element() rules and imports interleaved',
      css: fill(`${rule}@import "x.css";`),
    },
    {
      name: 'element() with whitespace before its parenthesis, then imports',
      css: fill('a{--x:element \t(x);}', half) + fill('@import "x.css";', half),
    },
    {
      // A string under nested @imports loads once for each of them, and is
      // mapped once (T06-19).
      name: 'element() rules, then imports nested in import blocks',
      css: fill(rule, half) + fill('@import { @import "x.css"; }', half),
      loadsEach: 2,
    },
    {
      name: 'imports whose strings sit inside element() spans',
      css: fill('@import{p{content:element("x.css")}}'),
    },
  ])('maps 64 KiB of $name in linear work', ({ css, loadsEach = 1 }) => {
    const before = pagedImportWork.visited;
    const loaded = pagedImports(css);
    const visited = pagedImportWork.visited - before;

    const offsets = quoted(css);
    expect(offsets.length).toBeGreaterThan(1000);
    expect(loaded).toEqual(
      offsets.map(offset => ({ url: 'x.css', offset, loads: loadsEach })),
    );
    // Every string's offset is mapped through the rewrites.
    expect(visited).toBeGreaterThanOrEqual(offsets.length);
    expect(visited / css.length).toBeLessThanOrEqual(linear);
  });
});
