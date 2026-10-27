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
