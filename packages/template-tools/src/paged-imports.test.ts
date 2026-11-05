// What Paged.js 0.4.3 fetches for a stylesheet's @imports: its Sheet.parse
// rewrites element(…) (RunningHeaders.beforeTreeParse), parses with css-tree
// 1.1.3, turns #ids in rules into strings (replaceIds), then loads every
// string under an @import, vendor-prefixed or nested, quotes stripped
// (Sheet.imports). The upload check reads the same loads (T06-9), each
// string once with the number of times Paged.js loads it (T06-19).
import { describe, expect, it } from 'vitest';
import { pagedImports } from './paged-imports.ts';

/** The offset just past the first `marker` (a quote or `#`) before `url`. */
const after = (css: string, written: string) => css.indexOf(written) + 1;

/**
 * Loads in Paged.js's order, as pagedImports reports them: each string once,
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

describe('pagedImports', () => {
  it.each<{ name: string; css: string; loads: [string, string][] }>([
    // [what Paged.js loads, the text it starts at, from its quote or #]
    {
      name: 'a quoted import',
      css: '@import "b.css";',
      loads: [['b.css', '"b.css"']],
    },
    {
      name: 'a quoted url() import',
      css: '@import url("b.css");',
      loads: [['b.css', '"b.css"']],
    },
    {
      name: 'a print-only import',
      css: '@import "b.css" print;',
      loads: [['b.css', '"b.css"']],
    },
    {
      name: 'a string after url() in a vendor-prefixed import',
      css: '@-webkit-import url(x) "a.css";',
      loads: [['a.css', '"a.css"']],
    },
    {
      name: 'a string inside an import block',
      css: '@import {p{content:"a.css"}}',
      loads: [['a.css', '"a.css"']],
    },
    {
      name: 'an ID selector in an import block, as replaceIds rewrites it',
      css: '@import {#a{}}',
      loads: [['a', '#a']],
    },
    {
      name: 'a NUL, kept as written',
      css: '@import "\0a.css";',
      loads: [['\0a.css', '"\0a.css"']],
    },
    {
      name: 'element(…) inside a filename, as RunningHeaders rewrites it',
      css: '@import "element(a).css";',
      loads: [['element-ident(a).css', '"element(a).css"']],
    },
    {
      // Paged.js throws on the second string of one @import, after reading
      // it, and loads nothing from the sheet; counting both errs on the
      // side of more loads.
      name: 'both strings of an import with a prelude and a block',
      css: '@import "b.css" {p{content:"c.css"}}',
      loads: [
        ['b.css', '"b.css"'],
        ['c.css', '"c.css"'],
      ],
    },
    {
      name: 'imports in document order',
      css: '@import "b.css";\n@import "c.css";',
      loads: [
        ['b.css', '"b.css"'],
        ['c.css', '"c.css"'],
      ],
    },
    {
      name: 'an import nested in @media',
      css: '@media print { @import "n.css"; }',
      loads: [['n.css', '"n.css"']],
    },
    {
      name: 'an import nested in a rule',
      css: 'p { @import "q.css"; }',
      loads: [['q.css', '"q.css"']],
    },
    {
      // Sheet.imports removes the @import itself, not the string, from the
      // tree, and the walk still descends into it: a string loads once for
      // every @import around it.
      name: 'an import nested in an import block twice',
      css: '@import { @import "in.css"; }',
      loads: [
        ['in.css', '"in.css"'],
        ['in.css', '"in.css"'],
      ],
    },
    {
      name: 'an import nested two deep three times',
      css: '@import { @import { @import "x.css"; } }',
      loads: [
        ['x.css', '"x.css"'],
        ['x.css', '"x.css"'],
        ['x.css', '"x.css"'],
      ],
    },
    {
      name: 'an unterminated string at the end of the sheet',
      css: '@import "a.css',
      loads: [['a.css', '"a.css']],
    },
    {
      name: 'an import after an element() rewrite earlier in the sheet',
      css: 'p{content:element  (x)}\n@import "b.css";',
      loads: [['b.css', '"b.css"']],
    },
    {
      name: 'strings inside element() spans, after other rewrites',
      css: 'p{a:element(x)}@import {p{content:element \n("a.css") element("b.css")}}',
      loads: [
        ['a.css', '"a.css"'],
        ['b.css', '"b.css"'],
      ],
    },
    {
      // Each @import's walk reads a then b: a and b load twice each.
      name: 'strings in two element() spans under nested imports',
      css: '@import { @import {p{content:element("a.css") element("b.css")}} }',
      loads: [
        ['a.css', '"a.css"'],
        ['b.css', '"b.css"'],
        ['a.css', '"a.css"'],
        ['b.css', '"b.css"'],
      ],
    },
    {
      name: 'an import after element() inside a comment',
      css: '/* element(x) */@import "b.css";',
      loads: [['b.css', '"b.css"']],
    },
  ])('loads $name', ({ css, loads }) => {
    expect(pagedImports(css)).toEqual(
      grouped(
        loads.map(([url, written]) => ({ url, offset: after(css, written) })),
      ),
    );
  });

  it.each([
    ['an unquoted url() import (css-tree keeps it Raw)', '@import url(b.css);'],
    [
      'a string after url() in an unprefixed import (css-tree falls back to Raw)',
      '@import url(x) "a.css";',
    ],
    ['a screen-only import', '@import "b.css" screen;'],
    ['a speech-only import', '@import "b.css" speech;'],
    ['an import for not print', '@import "b.css" not print;'],
    // Paged.js tests each identifier: after `not`, screen itself matches.
    ['an import for not screen', '@import "b.css" not screen;'],
    ['a hex colour, which is no ID selector', '@import {p{color:#abc}}'],
    ['a string outside any import', 'p{content:"x.css"}'],
    ['an import inside a comment', '/* @import "c.css"; */'],
    [
      '@-a-b-import, whose name without the vendor prefix is b-import',
      '@-a-b-import "a.css";',
    ],
  ])('loads nothing for %s', (_name, css) => {
    expect(pagedImports(css)).toEqual([]);
  });
});
