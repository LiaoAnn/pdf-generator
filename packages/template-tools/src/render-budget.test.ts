import { describe, expect, it } from 'vitest';
import { checkPack, fill, TemplateError } from './index.ts';

// All seven levels traverse the same ten-item array; no giant input is needed.
const opening = '{{#each @root.rows}}';
const statementsTemplate = `${opening.repeat(7)}{{this}}${'{{/each}}'.repeat(7)}`;
// In pre-order the 1,000,001st evaluated statement is a leaf mustache.
const leafColumn = opening.length * 7 + 1;
const outputTemplate = '{{#each rows}}\n  {{@root.text}}{{/each}}';
const fixtures = [
  {
    name: 'statement explosion',
    template: statementsTemplate,
    data: { rows: Array(10).fill(1), text: '' },
    line: 1,
    column: leafColumn,
  },
  {
    name: 'output explosion',
    template: outputTemplate,
    data: { rows: [1, 2], text: 'x'.repeat(9 * 1024 * 1024) },
    line: 2,
    column: 3,
  },
];

function pack(template: string, data: unknown) {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'budget-report',
      name: 'Budget',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: 'budget.hbs',
        styles: ['base.css'],
        rules: 'rules.json',
        sample: 'sample.json',
      },
    }),
    'budget.hbs': `<div data-gt="paragraph">${template}</div>`,
    'base.css': '',
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: {
        rows: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: 'integer', min: 0, max: 10 },
        },
        text: { type: 'constant', value: (data as { text: string }).text },
      },
    }),
    'sample.json': JSON.stringify(data),
  };
}

describe('render budgets stop untrusted packs before exhausting resources', () => {
  it.each(fixtures)(
    'fill stops $name at the evaluated statement',
    ({ template, data, line, column }) => {
      let caught: unknown;
      try {
        fill(template, data, { file: 'budget.hbs' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TemplateError);
      expect((caught as TemplateError).issues).toEqual([
        expect.objectContaining({
          code: 'template-render',
          file: 'budget.hbs',
          line,
          column,
        }),
      ]);
    },
    20000,
  );
  it.each(fixtures)(
    'checkPack stops sample $name at the evaluated statement',
    ({ template, data, line, column }) => {
      const result = checkPack(pack(template, data));
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('pack');
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'template-render',
          file: 'budget.hbs',
          line,
          column: column + (line === 1 ? 25 : 0),
        }),
      ]);
    },
    20000,
  );
  it('keeps modest nested rendering below both budgets deterministic', () => {
    const template = `${opening.repeat(2)}{{this}}${'{{/each}}'.repeat(2)}`;
    expect(fill(template, { rows: [1, 2] })).toBe('1212');
    expect(
      checkPack(pack(template, { rows: [1, 2], text: 'ok' })),
    ).toMatchObject({ ok: true, issues: [] });
  });
});
