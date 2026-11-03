import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

// Paged.js 0.4.3 loads every string under an @import, after rewriting
// element(…) and turning #ids into strings, and keeps a NUL that Chrome's
// parser would replace (see paged-imports.test.ts). The print runtime stops
// the loops and ladders built from these forms (T07-29); the upload check
// counts them too, the way Paged.js reads them (T06-9).

function pack(
  sheets: Record<string, string>,
  styles = ['styles/a.css'],
  head = '',
): PackFiles {
  const rules = rulesSchema.parse({
    schemaVersion: 1,
    fields: { holder: { type: 'name' } },
  });
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    id: 'paged-import-forms',
    name: 'Paged.js 引用形式測試',
    page: { size: 'A4', orientation: 'portrait' },
    files: {
      template: 'templates/report.hbs',
      styles,
      rules: 'data/rules.json',
      sample: 'data/sample.json',
      assets: Object.keys(sheets).filter(file => !styles.includes(file)),
    },
  });
  return {
    'manifest.json': JSON.stringify(manifest),
    'templates/report.hbs': withHead(
      `<head>${head}</head><p data-gt="paragraph">{{holder}}</p>`,
    ),
    'data/rules.json': JSON.stringify(rules),
    'data/sample.json': JSON.stringify(
      recordSchema(rules).parse({ holder: '王小明' }),
    ),
    ...sheets,
  };
}

/** Line and column (1-based) just after the first `prefix` in `text`. */
function after(text: string, prefix: string) {
  const at = text.indexOf(prefix);
  expect(at, `fixture contains ${JSON.stringify(prefix)}`).toBeGreaterThan(-1);
  const lines = text.slice(0, at + prefix.length).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

type Edge = { file: string; prefix: string; cycle: string };

/** The pack is refused with exactly these css-import-cycle issues. */
function refusesCycles(files: PackFiles, edges: Edge[]) {
  const result = checkPack(files);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  expect(result.issues).toHaveLength(edges.length);
  for (const { file, prefix, cycle } of edges) {
    expect(result.issues).toContainEqual({
      code: 'css-import-cycle',
      file,
      ...after(String(files[file]), prefix),
      message: expect.stringContaining(cycle),
    });
  }
}

const self = 'styles/a.css → styles/a.css';

describe('checkPack @import forms only Paged.js reads: cycles', () => {
  // The five packs T07-29's print test sends past the upload check.
  it.each<{ name: string; sheets: Record<string, string>; edges: Edge[] }>([
    {
      name: 'a string after url() in a vendor-prefixed @import',
      sheets: {
        'styles/a.css': '@-webkit-import url(x) "a.css";',
        'styles/x': '',
      },
      edges: [{ file: 'styles/a.css', prefix: 'url(x) "', cycle: self }],
    },
    {
      name: 'a string inside an @import block',
      sheets: { 'styles/a.css': '@import {p{content:"a.css"}}' },
      edges: [{ file: 'styles/a.css', prefix: 'content:"', cycle: self }],
    },
    {
      name: 'an ID selector inside an @import block',
      sheets: {
        'styles/a.css': '@import {#a{}}',
        'styles/a': '@import "a.css";',
      },
      edges: [
        {
          file: 'styles/a.css',
          prefix: '{#',
          cycle: 'styles/a.css → styles/a → styles/a.css',
        },
        {
          file: 'styles/a',
          prefix: '@import "',
          cycle: 'styles/a → styles/a.css → styles/a',
        },
      ],
    },
    {
      name: 'a NUL that Paged.js keeps and the URL parser trims',
      sheets: {
        'styles/a.css': '@import "\0a.css";',
        'styles/\uFFFDa.css': '',
      },
      edges: [{ file: 'styles/a.css', prefix: '@import "\0', cycle: self }],
    },
    {
      name: 'element(…) in a file name, which Paged.js rewrites to element-ident(…)',
      sheets: {
        'styles/a.css': '@import "element(a).css";',
        'styles/element(a).css': '',
        'styles/element-ident(a).css': '@import "a.css";',
      },
      edges: [
        {
          file: 'styles/a.css',
          prefix: '@import "',
          cycle: 'styles/a.css → styles/element-ident(a).css → styles/a.css',
        },
        {
          file: 'styles/element-ident(a).css',
          prefix: '@import "',
          cycle:
            'styles/element-ident(a).css → styles/a.css → styles/element-ident(a).css',
        },
      ],
    },
  ])('refuses a cycle through $name', ({ sheets, edges }) => {
    refusesCycles(pack(sheets), edges);
  });

  it.each([
    [
      'followed by another at-rule',
      '@import {p{content:"a.css"}}\n@media print {}',
    ],
    [
      // Chrome's reading ends the string at the newline and never sees the
      // @import; Paged.js's element() rewrite drops the newline first.
      'after a string the element() rewrite mends',
      'p{content:"element\n(a)"} @import {p{content:"a.css"}}',
    ],
  ])('refuses a Paged.js-only cycle %s', (_name, css) => {
    refusesCycles(pack({ 'styles/a.css': css }), [
      { file: 'styles/a.css', prefix: '@import {p{content:"', cycle: self },
    ]);
  });

  it('follows a Paged.js-only @import in a template <style> to the cycle it reaches', () => {
    refusesCycles(
      pack(
        {
          'styles/entry.css': '',
          'styles/a.css': '@import {p{content:"a.css"}}',
        },
        ['styles/entry.css'],
        '<style>@import {p{content:"../styles/a.css"}}</style>',
      ),
      [{ file: 'styles/a.css', prefix: 'content:"', cycle: self }],
    );
  });

  it('refuses a Paged.js-only @import of a file not in the pack at its URL', () => {
    const files = pack({ 'styles/a.css': '@import {p{content:"gone.css"}}' });
    const result = checkPack(files);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        code: 'asset-missing',
        file: 'styles/a.css',
        ...after(String(files['styles/a.css']), 'content:"'),
        message: expect.stringContaining('styles/gone.css'),
      },
    ]);
  });

  it('accepts a string after url() in an unprefixed @import, which css-tree reads as Raw and Paged.js never loads', () => {
    const result = checkPack(
      pack({ 'styles/a.css': '@import url(x) "a.css";', 'styles/x': '' }),
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/** One step of a ladder: the CSS that loads `next` once, and decoy files. */
type Form = {
  name: string;
  /** The file name step i loads (relative to styles/). */
  file: (i: number) => string;
  load: (next: number) => string;
  /** Files the other reading of the same CSS points at, left empty. */
  decoys?: (next: number) => Record<string, string>;
};

const forms: Form[] = [
  {
    name: 'strings inside @import blocks',
    file: i => `s${i}.css`,
    load: next => `@import {p{content:"s${next}.css"}}`,
  },
  {
    name: 'ID selectors inside @import blocks',
    // The manifest's styles must end in .css; the sheets it reaches need not.
    file: i => (i === 0 ? 's0.css' : `s${i}`),
    load: next => `@import {#s${next}{}}`,
  },
  {
    name: 'strings after url() in vendor-prefixed @imports',
    file: i => `s${i}.css`,
    load: next => `@-webkit-import url(x) "s${next}.css";`,
    decoys: () => ({ 'styles/x': '' }),
  },
  {
    name: 'NULs before the file name',
    file: i => `s${i}.css`,
    load: next => `@import "\0s${next}.css";`,
    decoys: next => ({ [`styles/\uFFFDs${next}.css`]: '' }),
  },
  {
    name: 'element(…) in file names',
    file: i => (i === 0 ? 's0.css' : `element-ident(s${i}).css`),
    load: next => `@import "element(s${next}).css";`,
    decoys: next => ({ [`styles/element(s${next}).css`]: '' }),
  },
];

describe('checkPack @import forms only Paged.js reads: expansion', () => {
  it.each(forms)(
    'refuses a ladder of 8 sheets, each loading the next twice through $name',
    form => {
      // 2^8 − 1 = 255 loads, past the 64-load limit.
      const sheets: Record<string, string> = {};
      for (let i = 0; i < 8; i++) {
        sheets[`styles/${form.file(i)}`] =
          i === 7
            ? 'p { margin: 0; }'
            : `${form.load(i + 1)}\n${form.load(i + 1)}`;
        if (i < 7) Object.assign(sheets, form.decoys?.(i + 1));
      }
      const result = checkPack(pack(sheets, [`styles/${form.file(0)}`]));
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        {
          code: 'css-import-expansion',
          file: `styles/${form.file(0)}`,
          message: expect.stringMatching(/\b64\b/),
        },
      ]);
    },
  );

  it('counts an @import nested in an @import block once for each @import around it', () => {
    // Paged.js loads b.css twice for each line: 1 + 32 × 2 = 65 loads,
    // though Chrome's reading of the same text sees 32 imports.
    const result = checkPack(
      pack({
        'styles/a.css': Array.from(
          { length: 32 },
          () => '@import { @import "b.css"; }',
        ).join('\n'),
        'styles/b.css': 'p { margin: 0; }',
      }),
    );
    expect(result.issues).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/a.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
  });

  it('counts a load only Chrome reads and one only Paged.js reads of the same file as two loads', () => {
    // Paged.js leaves url(b.css) for Chrome and loads the block's string
    // itself: 1 + 32 × 2 = 65 loads.
    const result = checkPack(
      pack({
        'styles/a.css': Array.from(
          { length: 32 },
          () => '@import url(b.css);\n@import {p{content:"b.css"}}',
        ).join('\n'),
        'styles/b.css': 'p { margin: 0; }',
      }),
    );
    expect(result.issues).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/a.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
  });

  it.each([
    ['@import url("b.css");', 'a quoted url() @import'],
    ['@import "b.css" print;', 'a print-only @import'],
  ])(
    'accepts 63 copies of %s: Chrome and Paged.js read %s as one load, not two',
    css => {
      const result = checkPack(
        pack({
          'styles/a.css': Array.from({ length: 63 }, () => css).join('\n'),
          'styles/b.css': 'p { margin: 0; }',
        }),
      );
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});
