import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { checkPack, type PackFiles, type PackIssue } from './index.ts';

const templateFile = 'templates/report.hbs';

function validFiles(template: string): PackFiles {
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    id: 'small-report',
    name: '測試報表',
    page: { size: 'A4', orientation: 'portrait' },
    files: {
      template: templateFile,
      styles: ['styles/base.css'],
      rules: 'data/rules.json',
      sample: 'data/sample.json',
    },
  });
  const rules = rulesSchema.parse({
    schemaVersion: 1,
    fields: {
      holder: { type: 'name' },
      amount: { type: 'integer', min: 0, max: 100, blankProbability: 0.5 },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'integer', min: 0, max: 10 },
      },
    },
  });
  const sample = recordSchema(rules).parse({
    holder: '王小明',
    amount: null,
    rows: [3, 4],
  });
  return {
    'manifest.json': JSON.stringify(manifest),
    [templateFile]: template,
    'styles/base.css': 'body { color: black; }',
    'data/rules.json': JSON.stringify(rules),
    'data/sample.json': JSON.stringify(sample),
  };
}

function rejected(
  template: string,
  expected: Omit<PackIssue, 'message' | 'file'>[],
) {
  const result = checkPack(validFiles(template));
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  expect(result.issues).toHaveLength(expected.length);
  expect(result.issues).toEqual(
    expect.arrayContaining(
      expected.map(issue =>
        expect.objectContaining({ ...issue, file: templateFile }),
      ),
    ),
  );
  for (const issue of result.issues) {
    expect(issue.message.trim().length).toBeGreaterThan(0);
  }
}

function accepted(template: string) {
  const result = checkPack(validFiles(template));
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.pack?.template).toBe(template);
}

describe('checkPack template coverage diagnostics', () => {
  it('rejects unmarked plain text at its first non-whitespace source character', () => {
    rejected('<body>\n  王小明</body>', [
      { code: 'gt-unmarked', line: 2, column: 3 },
    ]);
  });

  it('rejects an unmarked mustache even when its sample output is blank', () => {
    rejected('<body>\n  {{amount}}</body>', [
      { code: 'gt-unmarked', line: 2, column: 3 },
    ]);
  });

  it('checks unrendered else content instead of only the sample-selected branch', () => {
    rejected(
      '{{#if holder}}\n<p data-gt="paragraph">{{holder}}</p>\n{{else}}\n  <p>漏標</p>\n{{/if}}',
      [{ code: 'gt-unmarked', line: 4, column: 6 }],
    );
  });

  it('preserves multiline source locations after removing block tags and comments', () => {
    rejected(
      '{{#if holder}}\n{{!-- comment\nwith a second line --}}\n  <p>\n    漏標\n  </p>\n{{/if}}',
      [{ code: 'gt-unmarked', line: 5, column: 5 }],
    );
  });

  it('reports one issue per unmarked text node without merging across elements', () => {
    rejected('<div>甲<span>乙</span>丙</div>', [
      { code: 'gt-unmarked', line: 1, column: 6 },
      { code: 'gt-unmarked', line: 1, column: 13 },
      { code: 'gt-unmarked', line: 1, column: 21 },
    ]);
  });

  it.each([
    'img',
    'svg',
    'canvas',
    'picture',
    'video',
    'object',
    'embed',
    'iframe',
    'input',
    'select',
    'textarea',
    'math',
  ])('rejects an unmarked %s even without a text node', tag => {
    const element = ['img', 'embed', 'input'].includes(tag)
      ? `<${tag}>`
      : `<${tag}></${tag}>`;
    rejected(`<body>\n  ${element}\n</body>`, [
      { code: 'gt-unmarked', line: 2, column: 3 },
    ]);
  });

  it.each([
    ['empty', 'data-gt=""'],
    ['valueless', 'data-gt'],
    ['unknown', 'data-gt="name"'],
    ['different case', 'data-gt="Paragraph"'],
    ['surrounding whitespace', 'data-gt=" paragraph "'],
    ['dynamic', 'data-gt="{{holder}}"'],
  ])(
    'rejects a %s block type at the attribute name without unmarked cascades',
    (_name, attribute) => {
      rejected(`<p\n  ${attribute}>{{holder}}</p>`, [
        { code: 'gt-type', line: 2, column: 3 },
      ]);
    },
  );

  it('reports each invalid block type rather than stopping at the first attribute', () => {
    rejected('<p data-gt="bad">甲</p>\n<div data-gt="BAD">乙</div>', [
      { code: 'gt-type', line: 1, column: 4 },
      { code: 'gt-type', line: 2, column: 6 },
    ]);
  });

  it('rejects a nested mark at the inner attribute without unmarked text cascades', () => {
    rejected(
      '<section data-gt="paragraph">\n  <span data-gt="field">{{holder}}</span>\n</section>',
      [{ code: 'gt-nested', line: 2, column: 9 }],
    );
  });

  it.each(['data-gt-id=""', 'data-gt-id'])(
    'rejects an empty %s at its attribute name',
    attribute => {
      rejected(`<p data-gt="paragraph"\n  ${attribute}>{{holder}}</p>`, [
        { code: 'gt-id', line: 2, column: 3 },
      ]);
    },
  );

  it('keeps a valid marked pack with null sample values uploadable', () => {
    accepted(
      '<p data-gt="paragraph">{{holder}}</p>\n<p data-gt="field">{{amount}}/{{number amount}}</p>',
    );
  });

  it('ignores whitespace, nbsp entities, HTML and Handlebars comments, and nonprinted subtrees', () => {
    accepted(
      '<!doctype html><html><head><title>標題</title><meta charset="utf-8"></head><body>\n \t&nbsp;&#160;&#xA0;\n<!-- ignored <img> text -->\n{{! ignored }}\n{{!-- ignored\n<img> --}}\n<style>p::before { content: "x"; }</style><template><p>hidden</p><img></template><noscript><p>hidden</p><img></noscript>\n</body></html>',
    );
  });

  it('accepts all contract block types instead of an incomplete local allowlist', () => {
    accepted(
      [
        'title',
        'heading',
        'paragraph',
        'list_item',
        'label',
        'field',
        'table',
        'image',
        'caption',
        'formula',
        'checkbox',
        'barcode',
        'page_header',
        'page_footer',
        'page_number',
        'footnote',
        'reference',
      ]
        .map(type =>
          type === 'table'
            ? '<table data-gt="table"><tr><td>{{holder}}</td></tr></table>'
            : `<div data-gt="${type}"${type === 'checkbox' ? ' data-gt-checked="true"' : type === 'formula' ? ' data-gt-latex="x"' : ''}>{{holder}}</div>`,
        )
        .join('\n'),
    );
  });

  it('inherits marks through table cells and media without requiring child marks', () => {
    accepted(
      '<table data-gt="table"><tbody><tr><td>{{holder}}</td><td><img><svg></svg><input></td></tr></tbody></table>',
    );
  });

  it('allows dynamic and repeated ids for downstream suffixing', () => {
    accepted(
      '{{#each rows}}\n<p data-gt="field" data-gt-id="row-{{@index}}">{{this}}</p>\n{{/each}}\n<p data-gt="field" data-gt-id="same">甲</p><p data-gt="field" data-gt-id="same">乙</p>',
    );
  });
});

describe('checkPack sample rendering diagnostics', () => {
  it.each([
    ['root path', '{{missing}}', 5],
    ['helper argument', '{{number missing}}', 12],
    ['block condition', '{{#if missing}}yes{{/if}}', 9],
  ])(
    'locates a missing %s in the template rather than the sample JSON',
    (_name, statement, column) => {
      rejected(`<p data-gt="paragraph">\n  ${statement}\n</p>`, [
        { code: 'template-unknown-field', line: 2, column },
      ]);
    },
  );

  it('locates a sample helper type mismatch at its template statement', () => {
    rejected('<p data-gt="field">\n  {{number holder}}\n</p>', [
      { code: 'template-render', line: 2, column: 3 },
    ]);
  });

  it.each([
    ['raw mustache', '{{{holder}}}'],
    ['ampersand raw HTML', '{{& holder}}'],
    ['partial', '{{> missing}}'],
    ['partial block', '{{#> missing}}x{{/missing}}'],
    ['decorator', '{{*custom}}'],
    ['inline partial decorator', '{{#*inline "p"}}x{{/inline}}'],
    ['unknown inline helper', '{{custom missing}}'],
    ['unknown block helper', '{{#custom missing}}x{{/custom}}'],
    ['unknown subexpression helper', '{{#if (custom missing)}}x{{/if}}'],
  ])(
    'rejects %s at the statement and suppresses sample-render cascades',
    (_name, statement) => {
      rejected(`<p data-gt="paragraph">\n  ${statement}\n</p>`, [
        { code: 'template-unsupported', line: 2, column: 3 },
      ]);
    },
  );

  it('returns each unsupported statement without collapsing them into one issue', () => {
    rejected(
      '<p data-gt="paragraph">\n  {{{holder}}}\n  {{custom missing}}\n</p>',
      [
        { code: 'template-unsupported', line: 2, column: 3 },
        { code: 'template-unsupported', line: 3, column: 3 },
      ],
    );
  });

  it('suppresses unsupported, render and marking checks after a syntax error', () => {
    rejected(
      '<body>unmarked\n  {{#if holder}}\n  {{/each}}\n{{{missing}}}<img><p data-gt="invalid">bad</p></body>',
      [{ code: 'template-syntax', line: 2, column: 6 }],
    );
  });

  it('skips sample rendering when the record is invalid instead of adding template issues', () => {
    const files = validFiles('<p data-gt="field">{{number holder}}</p>');
    files['data/sample.json'] = '{"holder":42,"amount":null,"rows":[3]}';
    const result = checkPack(files);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      code: 'sample-invalid',
      file: 'data/sample.json',
      path: ['holder'],
      line: 1,
      column: 11,
    });
  });
});
