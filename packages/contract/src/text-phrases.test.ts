import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { rulesSchema } from './index.ts';

const validatePublished = new Ajv2020({ strict: true }).compile(
  JSON.parse(
    readFileSync(
      new URL('../schemas/rules.schema.json', import.meta.url),
      'utf8',
    ),
  ),
);

function text(phrases: unknown) {
  return { type: 'text', lang: 'mixed', minLength: 1, maxLength: 80, phrases };
}

function document(field: unknown) {
  return { schemaVersion: 1, fields: { narrative: field } };
}

describe('pack-supplied text phrases', () => {
  test('pack authors can retain their phrases in root, object and array text rules in both consumers', () => {
    const phrases = [' 現場採證 ', 'Witness statement', '現場採證'];
    const input = {
      schemaVersion: 1,
      fields: {
        narrative: text(phrases),
        incident: { type: 'object', fields: { findings: text(phrases) } },
        statements: {
          type: 'array',
          minItems: 0,
          maxItems: 2,
          items: text(phrases),
        },
        rows: {
          type: 'array',
          minItems: 0,
          maxItems: 2,
          items: { type: 'object', fields: { detail: text(phrases) } },
        },
      },
    };
    const result = rulesSchema.safeParse(input);
    expect.soft(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(input);
    expect
      .soft(validatePublished(input), JSON.stringify(validatePublished.errors))
      .toBe(true);
  });

  test.each([
    { label: 'one one-character phrase', phrases: ['字'] },
    { label: '1000 phrases', phrases: Array<string>(1000).fill('字') },
    { label: 'a 200-code-point phrase', phrases: ['字'.repeat(200)] },
    {
      label: 'untrimmed 200-character phrase',
      phrases: [` ${'字'.repeat(198)} `],
    },
    {
      label: '200 astral characters (400 code units)',
      phrases: ['😀'.repeat(200)],
    },
  ])('accepts $label without changing pack data', ({ phrases }) => {
    const input = document(text(phrases));
    const result = rulesSchema.safeParse(input);
    expect.soft(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(input);
    expect
      .soft(validatePublished(input), JSON.stringify(validatePublished.errors))
      .toBe(true);
  });

  test.each([
    { label: 'empty list', phrases: [], suffix: [] },
    {
      label: '1001 entries',
      phrases: Array<string>(1001).fill('字'),
      suffix: [],
    },
    { label: 'non-array value', phrases: '現場採證', suffix: [] },
    { label: 'null list', phrases: null, suffix: [] },
    { label: 'empty phrase', phrases: ['有效', ''], suffix: [1] },
    {
      label: '201-character phrase',
      phrases: ['有效', '字'.repeat(201)],
      suffix: [1],
    },
    { label: 'numeric entry', phrases: ['有效', 42], suffix: [1] },
    { label: 'null entry', phrases: ['有效', null], suffix: [1] },
  ])(
    'rejects $label at the offending value for pack diagnostics',
    ({ phrases, suffix }) => {
      const input = document(text(phrases));
      const result = rulesSchema.safeParse(input);
      expect.soft(result.success).toBe(false);
      if (!result.success) {
        expect
          .soft(result.error.issues.map(issue => issue.path))
          .toContainEqual(['fields', 'narrative', 'phrases', ...suffix]);
      }
      expect.soft(validatePublished(input)).toBe(false);
    },
  );

  test.each([' ', '\t\r\n', '\u3000\u00a0'])(
    'rejects whitespace-only phrase %j at its index rather than trimming it away',
    phrase => {
      const result = rulesSchema.safeParse(document(text(['有效', phrase])));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map(issue => issue.path)).toContainEqual([
          'fields',
          'narrative',
          'phrases',
          1,
        ]);
      }
    },
  );

  test('rejects 201 astral code points at the phrase index in both consumers', () => {
    const input = document(text(['😀'.repeat(201)]));
    const result = rulesSchema.safeParse(input);
    expect.soft(result.success).toBe(false);
    if (!result.success) {
      expect
        .soft(result.error.issues.map(issue => issue.path))
        .toContainEqual(['fields', 'narrative', 'phrases', 0]);
    }
    expect.soft(validatePublished(input)).toBe(false);
    expect(validatePublished.errors).toContainEqual(
      expect.objectContaining({
        instancePath: '/fields/narrative/phrases/0',
        keyword: 'maxLength',
      }),
    );
  });

  test('reports a malformed phrase through nested object and array item paths', () => {
    const input = document({
      type: 'array',
      minItems: 0,
      maxItems: 2,
      items: { type: 'object', fields: { detail: text(['有效', '']) } },
    });
    const result = rulesSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path)).toContainEqual([
        'fields',
        'narrative',
        'items',
        'fields',
        'detail',
        'phrases',
        1,
      ]);
    }
  });
});
