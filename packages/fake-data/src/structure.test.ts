import { createHash } from 'node:crypto';
import {
  type RuleField,
  type Rules,
  rulesSchema,
} from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { generate, recordSchema } from './index.ts';

// T16 fixtureSeed: SHA-256 hex of `${batchSeed}\n${index}`.
const seeds = Array.from({ length: 100 }, (_, index) =>
  createHash('sha256').update(`T12-structure-batch\n${index}`).digest('hex'),
);
const oneField = (value: RuleField): Rules => ({
  schemaVersion: 1,
  fields: { value },
});
const integer: RuleField = { type: 'integer', min: 0, max: 1_000_000 };
const object: RuleField = {
  type: 'object',
  fields: { reference: integer, holder: { type: 'name' } },
};
const array: RuleField = {
  type: 'array',
  minItems: 1,
  maxItems: 5,
  items: object,
};

describe('reproducible document structure through the public engine', () => {
  it('varies all six row counts, checked states and blanks across 100 batch fixtures without changing replay bytes', () => {
    const rules = rulesSchema.parse({
      schemaVersion: 1,
      fields: {
        rows: { ...array, minItems: 0 },
        paperless: { type: 'checkbox', probability: 0.7 },
        contact: { type: 'phone', kind: 'mobile', blankProbability: 0.3 },
      },
    });
    const schema = recordSchema(rules);
    const counts = Array<number>(6).fill(0);
    let checked = 0;
    let blank = 0;
    for (const seed of seeds) {
      const record = generate(rules, seed);
      expect(JSON.stringify(generate(rules, seed))).toBe(
        JSON.stringify(record),
      );
      expect(schema.parse(record)).toEqual(record);
      if (!Array.isArray(record.rows)) throw new Error('Expected table rows');
      counts[record.rows.length] = (counts[record.rows.length] ?? 0) + 1;
      expect(typeof record.paperless).toBe('boolean');
      if (record.paperless) checked++;
      if (record.contact === null) blank++;
    }
    // Broad deterministic bounds catch fixed counts and badly biased draws.
    expect(counts).toHaveLength(6);
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(5);
      expect(count).toBeLessThanOrEqual(30);
    }
    expect(checked / seeds.length).toBeGreaterThan(0.5);
    expect(checked / seeds.length).toBeLessThan(0.9);
    expect(blank / seeds.length).toBeGreaterThan(0.1);
    expect(blank / seeds.length).toBeLessThan(0.5);
  });

  it('honors checkbox endpoints and makes omitted probability identical to explicit 0.5', () => {
    const defaultRules = oneField({ type: 'checkbox' });
    const halfRules = oneField({ type: 'checkbox', probability: 0.5 });
    const neverRules = oneField({ type: 'checkbox', probability: 0 });
    const alwaysRules = oneField({ type: 'checkbox', probability: 1 });
    let checked = 0;
    for (const seed of seeds) {
      const record = generate(defaultRules, seed);
      expect(recordSchema(defaultRules).parse(record)).toEqual(record);
      expect(record).toEqual(generate(halfRules, seed));
      expect(generate(neverRules, seed)).toEqual({ value: false });
      expect(generate(alwaysRules, seed)).toEqual({ value: true });
      if (record.value) checked++;
    }
    expect(checked).toBeGreaterThan(30);
    expect(checked).toBeLessThan(70);
  });

  const blankable: RuleField[] = [
    { type: 'name' },
    { type: 'nationalId' },
    { type: 'businessId' },
    { type: 'company' },
    { type: 'address' },
    { type: 'phone', kind: 'mobile' },
    { type: 'date', min: '2026-01-01', max: '2026-12-31' },
    { type: 'money', min: 0, max: 100, decimals: 2 },
    integer,
    { type: 'number', min: 0, max: 1, decimals: 3 },
    { type: 'choice', options: ['TWD', false, 10] },
    { type: 'constant', value: 'TWD' },
    { type: 'checkbox' },
    object,
    array,
  ];
  it.each(blankable)(
    'blanks the entire $type value at probability 1 and preserves the original at probability 0',
    field => {
      const blankRules = oneField({ ...field, blankProbability: 1 });
      const record = generate(blankRules, seeds[0] ?? 'blank-endpoints');
      expect(record).toEqual({ value: null });
      expect(recordSchema(blankRules).parse(record)).toEqual(record);
      for (const seed of seeds.slice(0, 10)) {
        const nonblankRules = oneField({ ...field, blankProbability: 0 });
        const nonblank = generate(nonblankRules, seed);
        expect(nonblank.value).not.toBeNull();
        expect(nonblank).toEqual(generate(oneField(field), seed));
        expect(recordSchema(nonblankRules).parse(nonblank)).toEqual(nonblank);
      }
    },
  );

  it.each([integer, object, array, { type: 'checkbox' } satisfies RuleField])(
    'keeps nonblank $type values on the same seed stream when blankProbability is added',
    field => {
      const baseline = oneField(field);
      const nullable = oneField({ ...field, blankProbability: 0.3 });
      let nonblank = 0;
      let blank = 0;
      for (const seed of seeds) {
        const record = generate(nullable, seed);
        expect(recordSchema(nullable).parse(record)).toEqual(record);
        if (record.value === null) blank++;
        else {
          nonblank++;
          expect(record).toEqual(generate(baseline, seed));
        }
      }
      expect(blank).toBeGreaterThan(0);
      expect(nonblank).toBeGreaterThan(0);
    },
  );

  it('applies blanks inside objects and to array items without deleting keys or slots', () => {
    const rules = oneField({
      type: 'object',
      fields: {
        absent: { type: 'name', blankProbability: 1 },
        present: { type: 'constant', value: 'TWD', blankProbability: 0 },
        rows: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: { ...object, blankProbability: 1 },
        },
      },
    });
    const record = generate(rules, seeds[0] ?? 'nested-blanks');
    expect(record).toEqual({
      value: { absent: null, present: 'TWD', rows: [null, null, null] },
    });
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it.each([integer, object, array])(
    'keeps $type array items keyed by index across different drawn lengths and includes both nonzero bounds',
    items => {
      const ranged = (maxItems: number) =>
        oneField({
          type: 'array',
          minItems: 2,
          maxItems,
          items,
        });
      const shortRules = ranged(4);
      const longRules = ranged(7);
      const lengths = new Set<number>();
      let differentLengths = 0;
      for (const seed of seeds) {
        const short = generate(shortRules, seed);
        const long = generate(longRules, seed);
        expect(recordSchema(shortRules).parse(short)).toEqual(short);
        expect(recordSchema(longRules).parse(long)).toEqual(long);
        if (!Array.isArray(short.value) || !Array.isArray(long.value)) {
          throw new Error('Expected array values');
        }
        lengths.add(short.value.length);
        if (short.value.length !== long.value.length) differentLengths++;
        const sharedLength = Math.min(short.value.length, long.value.length);
        expect(short.value.slice(0, sharedLength)).toEqual(
          long.value.slice(0, sharedLength),
        );
      }
      expect(lengths).toEqual(new Set([2, 3, 4]));
      expect(differentLengths).toBeGreaterThan(0);
    },
  );
});
