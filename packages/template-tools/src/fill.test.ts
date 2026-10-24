import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { fill, type PackIssue, TemplateError } from './index.ts';

// Independent Node oracle: never use the interpreter's helper implementations.
const helpers = {
  eq: (a: unknown, b: unknown) => a === b,
  number: (value: number | null, options: Handlebars.HelperOptions) => {
    if (value === null) return '';
    const raw =
      options.hash.decimals === undefined
        ? String(value)
        : value.toFixed(options.hash.decimals);
    const [integer = '', fraction] = raw.split('.');
    return (
      integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
      (fraction === undefined ? '' : `.${fraction}`)
    );
  },
};

type Example = { name: string; template: string; data: unknown };
const corpus: Example[] = [
  {
    name: 'escapes all seven HTML characters without changing Chinese content',
    template: '<p data-gt="name">臺灣 {{name}}</p>',
    data: { name: '&<>"\'`=' },
  },
  {
    name: 'renders blank, boolean, numeric and array values like Handlebars',
    template: '{{nil}}|{{unset}}|{{yes}}|{{no}}|{{zero}}|{{decimal}}|{{list}}',
    data: {
      nil: null,
      unset: undefined,
      yes: true,
      no: false,
      zero: 0,
      decimal: -1.25,
      list: ['甲', '乙'],
    },
  },
  {
    name: 'resolves dotted and explicitly current paths',
    template:
      '{{a.b.c}}|{{this.name}}|{{./name}}|{{#with name}}{{this}}{{/with}}',
    data: { a: { b: { c: '深' } }, name: '王小明' },
  },
  {
    name: 'treats a null intermediate as a blank rather than an unknown field',
    template: 'A{{a.b.c}}B',
    data: { a: null },
  },
  {
    name: 'removes short and long comments and their standalone lines',
    template: 'A{{! short }}B\n  {{!-- long\ncomment --}}\nC',
    data: {},
  },
  {
    name: 'strips standalone block lines while preserving rendered indentation',
    template: 'A\n  {{#if ok}}\n    {{name}}\n  {{else}}\n    no\n  {{/if}}\nZ',
    data: { ok: true, name: '甲' },
  },
  {
    name: 'applies tilde whitespace control around blocks and expressions',
    template:
      ' A \n {{~#if ok~}} \n {{~name~}} \n {{~else~}} no {{~/if~}} \n Z ',
    data: { ok: true, name: '甲' },
  },
  {
    name: 'uses Handlebars truthiness for if and unless, including empty arrays and zero',
    template:
      '{{#each values}}[{{#if this}}T{{else}}F{{/if}}{{#unless this}}U{{else}}N{{/unless}}]{{/each}}',
    data: { values: [false, null, 0, '', [], [1], {}, true] },
  },
  ...[0, 1, 2, 3].map(value => ({
    name: `selects the correct else-if branch for value ${value}`,
    template:
      '{{#if (eq value 1)}}one{{else if (eq value 2)}}two{{else if (eq value 3)}}three{{else}}other{{/if}}',
    data: { value },
  })),
  {
    name: 'keeps nested each parent depth, root and iteration metadata distinct',
    template:
      '{{#each groups}}[{{@index}}:{{@first}}:{{@last}}:{{name}}{{#each rows}}({{@index}}:{{@first}}:{{@last}}:{{this}}:{{../name}}:{{../../title}}:{{@root.title}}){{/each}}]{{/each}}',
    data: {
      title: '總表',
      groups: [
        { name: '甲', rows: [10, 20] },
        { name: '乙', rows: [30] },
      ],
    },
  },
  {
    name: 'iterates object own keys in Handlebars order with key metadata',
    template:
      '{{#each entries}}{{@key}}={{this}}:{{@index}}:{{@first}}:{{@last}};{{else}}empty{{/each}}',
    data: { entries: { '2': '二', '1': '一', z: '末', a: '首' } },
  },
  {
    name: 'binds each block parameters without losing the parent context',
    template:
      '{{#each rows as |item i|}}{{i}}={{item.name}}/{{../title}};{{/each}}',
    data: { title: '名冊', rows: [{ name: '甲' }, { name: '乙' }] },
  },
  {
    name: 'renders each inverse for empty arrays and objects',
    template:
      '{{#each array}}bad{{else}}array empty{{/each}}|{{#each object}}bad{{else}}object empty{{/each}}',
    data: { array: [], object: {} },
  },
  {
    name: 'switches with context and renders its inverse for null',
    template:
      '{{#with person}}{{name}}/{{../title}}{{else}}bad{{/with}}|{{#with blank}}bad{{else}}blank{{/with}}',
    data: { person: { name: '甲' }, title: '主管', blank: null },
  },
  {
    name: 'resolves dynamic lookup keys for objects and arrays',
    template:
      '{{lookup person key}}|{{lookup rows 1}}|{{#if (eq (lookup person key) "甲")}}match{{/if}}',
    data: { person: { name: '甲' }, key: 'name', rows: ['零', '一'] },
  },
  {
    name: 'keeps literal types and strict equality in inline helpers and subexpressions',
    template:
      '{{eq "a" "a"}}|{{eq 1 "1"}}|{{eq true false}}|{{eq null nil}}|{{eq undefined unset}}|{{#if (eq value -2.5)}}yes{{/if}}',
    data: { nil: null, unset: undefined, value: -2.5 },
  },
  {
    name: 'gives helpers precedence over equally named data fields',
    template: '{{eq a b}}|{{number value}}',
    data: { eq: 'shadow', number: 'shadow', a: 1, b: 1, value: 1234 },
  },
  {
    name: 'groups signed integers and fractions and honors fixed decimal digits',
    template:
      '{{number whole}}|{{number negative}}|{{number fraction}}|{{number fraction decimals=2}}|{{number whole decimals=0}}|{{number nil}}|{{number zero decimals=2}}',
    data: {
      whole: 1234567,
      negative: -1234.5,
      fraction: 1234.567,
      nil: null,
      zero: 0,
    },
  },
];

function rejected(
  template: string,
  data: unknown,
  options?: { file?: string },
): TemplateError {
  try {
    fill(template, data, options);
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    return error as TemplateError;
  }
  throw new Error('Expected fill to reject the template');
}

function expectIssue(error: TemplateError, issue: Partial<PackIssue>): void {
  expect(error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...issue, message: expect.any(String) }),
    ]),
  );
  for (const actual of error.issues) {
    expect(actual.file).toBe(issue.file);
    expect(actual.message.length).toBeGreaterThan(0);
  }
}

describe('public fill acceptance: eval-free Handlebars subset', () => {
  it.each(corpus)('$name', ({ template, data }) => {
    // Compute the reference first: an invalid fixture must not masquerade as RED.
    const expected = Handlebars.compile(template)(data, { helpers });
    expect(fill(template, data, { file: 'invoice.hbs' })).toBe(expected);
    expect(fill(template, data, { file: 'invoice.hbs' })).toBe(expected);
  });
});

describe('fill diagnostics locate pack author mistakes', () => {
  it('round 6 wraps a text conversion failure at the statement as TemplateError', () => {
    expectIssue(
      rejected(
        '<p data-gt="paragraph">\n  {{value}}</p>',
        { value: { toString: 'x' } },
        { file: 'conversion.hbs' },
      ),
      {
        code: 'template-render',
        file: 'conversion.hbs',
        line: 2,
        column: 3,
      },
    );
  });

  it.each([
    ['triple-stash', '{{{x}}}'],
    ['ampersand raw HTML', '{{& x}}'],
    ['partial', '{{> p}}'],
    ['partial block', '{{#> p}}x{{/p}}'],
    ['inline partial decorator', '{{#*inline "p"}}x{{/inline}}'],
    ['inline decorator', '{{*custom}}'],
    ['unknown block helper', '{{#custom x}}x{{/custom}}'],
    ['unknown inline helper', '{{format x}}'],
    ['unknown subexpression helper', '{{#if (custom x)}}x{{/if}}'],
  ])(
    'rejects %s at its statement instead of silently rendering it',
    (_name, statement) => {
      expectIssue(
        rejected(
          `heading\n  ${statement}`,
          { x: 'safe' },
          { file: 'pack/body.hbs' },
        ),
        {
          code: 'template-unsupported',
          file: 'pack/body.hbs',
          line: 2,
          column: 3,
        },
      );
    },
  );

  it.each([
    {
      name: 'root field',
      template: 'head\n  {{missing}}',
      data: {},
      column: 5,
    },
    {
      name: 'nested segment',
      template: 'head\n  {{person.missing}}',
      data: { person: {} },
      column: 5,
    },
    {
      name: 'helper parameter',
      template: 'head\n  {{number missing}}',
      data: {},
      column: 12,
    },
    {
      name: 'block condition',
      template: 'head\n  {{#if missing}}yes{{/if}}',
      data: {},
      column: 9,
    },
    {
      name: 'parent path',
      template: '{{#each rows}}\n  {{../missing}}{{/each}}',
      data: { rows: [1] },
      column: 5,
    },
    {
      name: 'root data path',
      template: '{{#with person}}\n  {{@root.missing}}{{/with}}',
      data: { person: {} },
      column: 5,
    },
    {
      name: 'inherited Object property',
      template: 'head\n  {{person.toString}}',
      data: { person: {} },
      column: 5,
    },
  ])(
    'rejects missing $name at the path rather than emitting a blank',
    ({ template, data, column }) => {
      expectIssue(rejected(template, data), {
        code: 'template-unknown-field',
        file: 'template.hbs',
        line: 2,
        column,
      });
    },
  );

  it('rejects a missing own property on a custom prototype', () => {
    const person: unknown = Object.create({ name: 'inherited' });
    expectIssue(
      rejected('head\n  {{person.name}}', { person }, { file: 'custom.hbs' }),
      {
        code: 'template-unknown-field',
        file: 'custom.hbs',
        line: 2,
        column: 5,
      },
    );
  });

  it('wraps parser failures with the line reported by Handlebars', () => {
    expectIssue(rejected('head\n  {{else}}', {}), {
      code: 'template-syntax',
      file: 'template.hbs',
      line: 2,
    });
  });

  it('converts the parser mismatch column to a one-based source location', () => {
    expectIssue(
      rejected(
        'head\n  {{#if ok}}\n  {{/each}}',
        { ok: true },
        { file: 'broken.hbs' },
      ),
      {
        code: 'template-syntax',
        file: 'broken.hbs',
        line: 2,
        column: 6,
      },
    );
  });

  it.each([
    { kind: 'string', value: '1234' },
    { kind: 'boolean', value: true },
    { kind: 'array', value: [] },
    { kind: 'object', value: {} },
  ])(
    'reports number helper type errors for $kind at the statement',
    ({ value }) => {
      expectIssue(
        rejected('head\n  {{number value}}', { value }, { file: 'amount.hbs' }),
        {
          code: 'template-render',
          file: 'amount.hbs',
          line: 2,
          column: 3,
        },
      );
    },
  );
});

describe('review regressions: Handlebars data frames and boxed strings', () => {
  it.each([
    {
      name: 'parent index follows outer each rather than the current row',
      template:
        '{{#each groups}}{{#each rows}}[{{@../index}}:{{@index}}]{{/each}}{{/each}}',
      data: { groups: [{ rows: ['a', 'b'] }, { rows: ['c'] }] },
    },
    {
      name: 'parent keys and boundary flags survive if, unless and with without extra data frames',
      template:
        '{{#each groups}}{{#each rows}}{{#if this}}{{#unless nope}}{{#with detail}}[{{@../key}}:{{@../first}}:{{@../last}}:{{@index}}]{{/with}}{{/unless}}{{/if}}{{/each}}{{/each}}',
      data: {
        groups: {
          a: {
            rows: [
              { nope: false, detail: {} },
              { nope: false, detail: {} },
            ],
          },
          b: { rows: [{ nope: false, detail: {} }] },
        },
      },
    },
    {
      name: 'two parent data hops differ from one parent hop',
      template:
        '{{#each groups}}{{#each rows}}{{#each this}}[{{@../../index}}:{{@../index}}:{{@index}}]{{/each}}{{/each}}{{/each}}',
      data: { groups: [{ rows: [['a', 'b'], ['c']] }, { rows: [['d']] }] },
    },
    {
      name: 'string own length is readable without enabling inherited properties',
      template: '{{name.length}}',
      data: { name: 'Ann' },
    },
    {
      name: 'lookup reads string own indices',
      template: '{{lookup name 0}}',
      data: { name: 'Ann' },
    },
  ])('$name', ({ template, data }) => {
    const expected = Handlebars.compile(template)(data);
    expect(fill(template, data)).toBe(expected);
  });
  it.each(['constructor', 'toString'])(
    'rejects Object.prototype helper name %s without crashing validation',
    name => {
      const error = rejected(
        `head\n  {{${name} x}}`,
        { x: 1 },
        { file: 'prototype.hbs' },
      );
      expect(error.issues).toEqual([
        expect.objectContaining({
          code: 'template-unsupported',
          file: 'prototype.hbs',
          line: 2,
          column: 3,
        }),
      ]);
    },
  );
  it.each([-1, 1.5, 21])(
    'rejects invalid number decimals=%s at the statement',
    decimals => {
      const error = rejected(
        `head\n  {{number value decimals=${decimals}}}`,
        { value: 12.34 },
        { file: 'number.hbs' },
      );
      expect(error.issues).toEqual([
        expect.objectContaining({
          code: 'template-render',
          file: 'number.hbs',
          line: 2,
          column: 3,
        }),
      ]);
    },
  );
});
