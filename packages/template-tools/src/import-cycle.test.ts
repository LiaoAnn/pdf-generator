import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

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
    id: 'import-cycle',
    name: '循環引用測試',
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

type CycleEdge = { file: string; url: string; cycle: string };

function rejectsCycles(files: PackFiles, edges: CycleEdge[]) {
  const result = checkPack(files);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  expect(result.issues).toHaveLength(edges.length);
  for (const { file, url, cycle } of edges) {
    const source = String(files[file]);
    const offset = source.indexOf(url);
    expect(offset, `fixture contains ${url}`).toBeGreaterThanOrEqual(0);
    const lines = source.slice(0, offset).split('\n');
    expect(result.issues).toContainEqual({
      code: 'css-import-cycle',
      file,
      line: lines.length,
      column: (lines.at(-1)?.length ?? 0) + 1,
      message: expect.stringContaining(cycle),
    });
  }
}

const mutual = [
  {
    file: 'styles/a.css',
    url: './b.css',
    cycle: 'styles/a.css → styles/b.css → styles/a.css',
  },
  {
    file: 'styles/b.css',
    url: '../styles/a.css',
    cycle: 'styles/b.css → styles/a.css → styles/b.css',
  },
];

describe('checkPack CSS import cycles', () => {
  it.each(['-webkit-import', '-FOO-Import'])(
    'rejects a self-cycle loaded by vendor-prefixed @%s at its URL',
    name => {
      rejectsCycles(
        pack({ 'styles/a.css': `/* heading */\n  @${name} "a.css";` }),
        [
          {
            file: 'styles/a.css',
            url: 'a.css',
            cycle: 'styles/a.css → styles/a.css',
          },
        ],
      );
    },
  );

  it('reaches a vendor-prefixed self-cycle through a vendor-prefixed template inline import', () => {
    rejectsCycles(
      pack(
        {
          'styles/a.css': '',
          'templates/x.css': '@-moz-import "x.css";',
        },
        ['styles/a.css'],
        '<style>@-webkit-import "x.css";</style>',
      ),
      [
        {
          file: 'templates/x.css',
          url: 'x.css',
          cycle: 'templates/x.css → templates/x.css',
        },
      ],
    );
  });

  it('accepts @-a-b-import because removing one vendor prefix leaves b-import', () => {
    const result = checkPack(pack({ 'styles/a.css': '@-a-b-import "a.css";' }));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.pack).toBeDefined();
  });

  it('checks a vendor-prefixed import for a missing asset at its URL', () => {
    const result = checkPack(
      pack({ 'styles/a.css': '@-webkit-import "missing.css";' }),
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('pack');
    expect(result.issues).toEqual([
      {
        code: 'asset-missing',
        file: 'styles/a.css',
        line: 1,
        column: 18,
        message: expect.stringContaining('styles/missing.css'),
      },
    ]);
  });

  it('strips embedded quotes from a stylesheet import before checking for a self-cycle', () => {
    rejectsCycles(
      pack({
        'styles/a.css': `/* heading */\n  @import "a'.css";`,
        "styles/a'.css": '',
      }),
      [
        {
          file: 'styles/a.css',
          url: "a'.css",
          cycle: 'styles/a.css → styles/a.css',
        },
      ],
    );
  });

  it('finds both mutual cycle edges after stripping an embedded quote from an import', () => {
    rejectsCycles(
      pack({
        'styles/a.css': `@import "b'.css";`,
        "styles/b'.css": '',
        'styles/b.css': "@import 'a.css';",
      }),
      [
        {
          file: 'styles/a.css',
          url: "b'.css",
          cycle: 'styles/a.css → styles/b.css → styles/a.css',
        },
        {
          file: 'styles/b.css',
          url: 'a.css',
          cycle: 'styles/b.css → styles/a.css → styles/b.css',
        },
      ],
    );
  });

  it('refuses a missing quote-stripped import target even when the quoted filename exists', () => {
    const result = checkPack(
      pack({
        'styles/a.css': `/* heading */\n  @import "c'.css";`,
        "styles/c'.css": '',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('pack');
    expect(result.issues).toEqual([
      {
        code: 'asset-missing',
        file: 'styles/a.css',
        line: 2,
        column: 12,
        message: expect.stringContaining('styles/c.css'),
      },
    ]);
  });

  it('reaches a stylesheet self-cycle through a quote-stripped template inline import', () => {
    rejectsCycles(
      pack(
        {
          'styles/entry.css': '',
          'styles/x.css': '@import "x.css";',
          "styles/x'.css": '',
        },
        ['styles/entry.css'],
        `<style>@import "../styles/x'.css";</style>`,
      ),
      [
        {
          file: 'styles/x.css',
          url: 'x.css',
          cycle: 'styles/x.css → styles/x.css',
        },
      ],
    );
  });

  it.each(['', '#x', '?v=2'])(
    'rejects an empty-path import "%s" as a self-cycle instead of skipping it or resolving to the directory',
    url => {
      const result = checkPack(
        pack({ 'styles/a.css': `/* heading */\n  @import "${url}";` }),
      );
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('pack');
      expect(result.issues).toEqual([
        {
          code: 'css-import-cycle',
          file: 'styles/a.css',
          line: 2,
          column: 12,
          message: expect.stringContaining('styles/a.css → styles/a.css'),
        },
      ]);
    },
  );

  it('accepts an SVG fragment URL in a property instead of treating it as a self-import', () => {
    const result = checkPack(
      pack({ 'styles/a.css': 'p { filter: url(#blur); }' }),
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.pack).toBeDefined();
  });

  it('reports duplicate cyclic imports at both URL positions instead of deduplicating their diagnostics', () => {
    const result = checkPack(
      pack({
        'styles/a.css': '@import "b.css";\n  @import "b.css";',
        'styles/b.css': '@import "a.css";',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      ...[1, 2].map(line => ({
        code: 'css-import-cycle',
        file: 'styles/a.css',
        line,
        column: line === 1 ? 10 : 12,
        message: expect.stringContaining(
          'styles/a.css → styles/b.css → styles/a.css',
        ),
      })),
      {
        code: 'css-import-cycle',
        file: 'styles/b.css',
        line: 1,
        column: 10,
        message: expect.stringContaining(
          'styles/b.css → styles/a.css → styles/b.css',
        ),
      },
    ]);
  });

  it.each([50, 80])(
    'bounds %i cyclic imports to 50 detailed issues and one overflow count only when needed',
    count => {
      const result = checkPack(
        pack({
          'styles/a.css': Array.from(
            { length: count },
            () => '@import "a.css";',
          ).join('\n'),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('pack');
      expect(result.issues).toEqual([
        ...Array.from({ length: 50 }, (_, index) => ({
          code: 'css-import-cycle',
          file: 'styles/a.css',
          line: index + 1,
          column: 10,
          message: expect.stringContaining('styles/a.css → styles/a.css'),
        })),
        ...(count > 50
          ? [
              {
                code: 'css-import-cycle',
                file: 'styles/a.css',
                line: 51,
                column: 10,
                message: expect.stringMatching(/\b30\b/),
              },
            ]
          : []),
      ]);
    },
  );

  it('applies the diagnostic cap in manifest order before reached sheets instead of traversal or filename order', () => {
    const selfImports = (name: string, count: number) =>
      Array.from({ length: count }, () => `@import "${name}.css";`).join('\n');
    const result = checkPack(
      pack(
        {
          'styles/a.css': `${selfImports('a', 20)}\n@import "c.css";`,
          'styles/b.css': selfImports('b', 20),
          'styles/c.css': selfImports('c', 40),
        },
        ['styles/b.css', 'styles/a.css'],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      ...(
        [
          ['b', 20],
          ['a', 20],
          ['c', 10],
        ] as const
      ).flatMap(([name, count]) =>
        Array.from({ length: count }, (_, index) => ({
          code: 'css-import-cycle',
          file: `styles/${name}.css`,
          line: index + 1,
          column: 10,
          message: expect.stringContaining(
            `styles/${name}.css → styles/${name}.css`,
          ),
        })),
      ),
      {
        code: 'css-import-cycle',
        file: 'styles/c.css',
        line: 11,
        column: 10,
        message: expect.stringMatching(/\b30\b/),
      },
    ]);
  });

  it('rejects a self-import at its URL so it cannot reach the pagination timeout', () => {
    rejectsCycles(
      pack({ 'styles/a.css': '/* heading */\n  @import "a.css";' }),
      [
        {
          file: 'styles/a.css',
          url: 'a.css',
          cycle: 'styles/a.css → styles/a.css',
        },
      ],
    );
  });

  it('reports both mutual imports at their URL positions with normalized pack paths', () => {
    rejectsCycles(
      pack(
        {
          'styles/a.css': '/* heading\ncomment */\n  @import "./b.css";',
          'styles/b.css': '@import url(\n  "../styles/a.css"\n);',
        },
        ['styles/a.css', 'styles/b.css'],
      ),
      mutual,
    );
  });

  it('reports all three cycle edges even when imported sheets are assets rather than manifest styles', () => {
    rejectsCycles(
      pack({
        'styles/a.css': '@import "b.css";',
        'styles/b.css': "@import 'c.css';",
        'styles/c.css': '@import url(a.css);',
      }),
      [
        {
          file: 'styles/a.css',
          url: 'b.css',
          cycle: 'styles/a.css → styles/b.css → styles/c.css → styles/a.css',
        },
        {
          file: 'styles/b.css',
          url: 'c.css',
          cycle: 'styles/b.css → styles/c.css → styles/a.css → styles/b.css',
        },
        {
          file: 'styles/c.css',
          url: 'a.css',
          cycle: 'styles/c.css → styles/a.css → styles/b.css → styles/c.css',
        },
      ],
    );
  });

  it.each([
    ['inline style import', '<style>@import "../styles/a.css";</style>'],
    ['stylesheet link', '<link rel="stylesheet" href="../styles/a.css">'],
  ])(
    'finds a cycle reached only through a template %s without blaming the template',
    (_name, head) => {
      rejectsCycles(
        pack(
          {
            'styles/entry.css': '',
            'styles/a.css': '@import "./b.css";',
            'styles/b.css': '@import url("../styles/a.css");',
          },
          ['styles/entry.css'],
          head,
        ),
        mutual,
      );
    },
  );

  it('reports only cycle edges when the same stylesheet also imports an acyclic dependency', () => {
    rejectsCycles(
      pack({
        'styles/a.css': '@import "safe.css";\n@import "./b.css";',
        'styles/b.css': '@import "../styles/a.css";',
        'styles/safe.css': 'p { color: black; }',
      }),
      mutual,
    );
  });

  it.each([
    [
      'nested imports',
      {
        'styles/a.css': '@import "b.css";',
        'styles/b.css': '@import "c.css";',
        'styles/c.css': '',
      },
    ],
    [
      'a diamond sharing a dependency',
      {
        'styles/a.css': '@import "b.css";\n@import "c.css";',
        'styles/b.css': '@import "d.css";',
        'styles/c.css': '@import "d.css";',
        'styles/d.css': '',
      },
    ],
    [
      'duplicate imports from one sheet',
      {
        'styles/a.css': '@import "b.css";\n@import url("./b.css");',
        'styles/b.css': '',
      },
    ],
  ])(
    'accepts %s rather than mistaking an already visited stylesheet for a cycle',
    (_name, sheets) => {
      const result = checkPack(pack(sheets));
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.pack).toBeDefined();
    },
  );
});
