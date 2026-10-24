import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type RuleField,
  type Rules,
  rulesSchema,
} from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { generate, InvalidRulesError, recordSchema } from './index.ts';

const seeds = Array.from({ length: 100 }, (_, index) =>
  createHash('sha256').update(`T12-derived-batch\n${index}`).digest('hex'),
);
const constant = (value: number): RuleField => ({ type: 'constant', value });
const rulesFor = (fields: Rules['fields']): Rules =>
  rulesSchema.parse({ schemaVersion: 1, fields });
const money: RuleField = { type: 'money', min: -1000, max: 1000, decimals: 2 };

// Parse printed decimal digits, without summing or scaling binary floats.
function cents(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== 'number') throw new Error('Expected money');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Not a cent amount: ${value}`);
  const magnitude =
    BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}

// Integer quotient/remainder oracle: nearest, ties away from zero.
function percent(part: bigint, whole: bigint, decimals: number): number | null {
  if (whole === 0n) return null;
  const scale = 10n ** BigInt(decimals);
  const numerator = part * 100n * scale;
  const negative = numerator < 0n !== whole < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = whole < 0n ? -whole : whole;
  const rounded = n / d + (2n * (n % d) >= d ? 1n : 0n);
  return rounded === 0n
    ? 0
    : Number(negative ? -rounded : rounded) / Number(scale);
}

function rejectsAt(rules: Rules, prefix: (string | number)[]) {
  let caught: unknown;
  try {
    generate(rules, 'invalid-derived');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidRulesError);
  if (!(caught instanceof InvalidRulesError))
    throw new Error('Expected InvalidRulesError');
  expect(
    caught.issues.some(issue =>
      prefix.every((key, index) => issue.path[index] === key),
    ),
  ).toBe(true);
}

describe('derived document numbers through the public engine', () => {
  it('CLI keeps exact cent totals, independently rounded percentages and replay bytes across 100 batch fixtures', () => {
    const rules = rulesFor({
      rows: {
        type: 'array',
        minItems: 0,
        maxItems: 20,
        items: {
          type: 'object',
          fields: { amount: { ...money, blankProbability: 0.3 } },
        },
      },
      whole: {
        type: 'money',
        min: 0,
        max: 1,
        decimals: 2,
        blankProbability: 0.2,
      },
      total: { type: 'sum', of: ['rows[].amount'] },
      ratio: { type: 'percentage', part: 'total', whole: 'whole', decimals: 2 },
    });
    // Run the package entry point in real Node processes, as fixture consumers do.
    const script = `
      import { readFileSync } from 'node:fs';
      import { generate, recordSchema } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const { rules, seeds } = JSON.parse(readFileSync(0, 'utf8'));
      const schema = recordSchema(rules);
      process.stdout.write(JSON.stringify(seeds.map(seed => schema.parse(generate(rules, seed)))));
    `;
    const run = () =>
      execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          input: JSON.stringify({ rules, seeds }),
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    const bytes = run();
    expect(run()).toBe(bytes);
    const records: Record<string, unknown>[] = JSON.parse(bytes);
    expect(records).toHaveLength(100);
    const schema = recordSchema(rules);
    const lengths = new Set<number>();
    let blankAmounts = 0;
    let zeroWholes = 0;
    for (const record of records) {
      expect(schema.parse(record)).toEqual(record);
      if (!Array.isArray(record.rows)) throw new Error('Expected rows');
      lengths.add(record.rows.length);
      let total = 0n;
      for (const row of record.rows) {
        if (row === null || typeof row !== 'object' || Array.isArray(row))
          throw new Error('Expected row object');
        total += cents(row.amount);
        if (row.amount === null) blankAmounts++;
      }
      expect(record.total).toBe(Number(total) / 100);
      expect(Object.is(record.total, -0)).toBe(false);
      const whole = cents(record.whole);
      if (whole === 0n) zeroWholes++;
      expect(record.ratio).toBe(percent(total, whole, 2));
    }
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(20)).toBe(true);
    expect(blankAmounts).toBeGreaterThan(0);
    expect(zeroWholes).toBeGreaterThan(0);
  });

  it('resolves root paths through every nested array, including from each row of that same array', () => {
    const rules = rulesFor({
      groups: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: {
          type: 'object',
          fields: {
            rows: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: {
                type: 'object',
                fields: {
                  amount: constant(0.1),
                  grandTotal: { type: 'sum', of: ['groups[].rows[].amount'] },
                },
              },
            },
          },
        },
      },
      summary: {
        type: 'object',
        fields: {
          total: {
            type: 'sum',
            of: ['groups[].rows[].amount', 'extra.amount'],
          },
        },
      },
      extra: { type: 'object', fields: { amount: constant(0.2) } },
    });
    const record = generate(rules, 'nested-root-paths');
    const row = { amount: 0.1, grandTotal: 0.6 };
    expect(record).toEqual({
      groups: [{ rows: [row, row, row] }, { rows: [row, row, row] }],
      summary: { total: 0.8 },
      extra: { amount: 0.2 },
    });
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it('treats blank leaves, blank containers and empty arrays as zero without producing negative zero', () => {
    const rules = rulesFor({
      leaf: { ...constant(9), blankProbability: 1 },
      object: {
        type: 'object',
        blankProbability: 1,
        fields: { amount: constant(9) },
      },
      absent: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        blankProbability: 1,
        items: constant(9),
      },
      empty: { type: 'array', minItems: 0, maxItems: 0, items: constant(9) },
      blankRows: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: {
          type: 'object',
          blankProbability: 1,
          fields: { amount: constant(9) },
        },
      },
      total: {
        type: 'sum',
        of: [
          'leaf',
          'object.amount',
          'absent[]',
          'empty[]',
          'blankRows[].amount',
        ],
      },
      whole: constant(-1),
      ratio: { type: 'percentage', part: 'total', whole: 'whole', decimals: 2 },
    });
    const record = generate(rules, 'blank-paths');
    expect(record).toMatchObject({
      leaf: null,
      object: null,
      absent: null,
      empty: [],
      blankRows: [null, null],
      total: 0,
      ratio: 0,
    });
    expect(Object.is(record.total, -0)).toBe(false);
    expect(Object.is(record.ratio, -0)).toBe(false);
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it.each([
    ['binary decimal addition', constant(0.1), constant(0.2), 0.3],
    [
      'six decimal number fields',
      { type: 'number', min: 0.000001, max: 0.000001, decimals: 6 },
      { type: 'number', min: 0.000002, max: 0.000002, decimals: 6 },
      0.000003,
    ],
    ['small numeric constants', constant(1e-7), constant(2e-7), 3e-7],
    [
      'cancellation around a large constant',
      constant(1e16),
      constant(-1e16),
      0,
    ],
  ] satisfies [string, RuleField, RuleField, number][])(
    'sums %s exactly',
    (_name, a, b, expected) => {
      const rules = rulesFor({ a, b, total: { type: 'sum', of: ['a', 'b'] } });
      const record = generate(rules, 'exact-decimals');
      expect(record.total).toBe(expected);
      expect(recordSchema(rules).parse(record)).toEqual(record);
    },
  );

  it.each([
    [1, 800, 2, 0.13],
    [-1, 800, 2, -0.13],
    [1, -800, 2, -0.13],
    [-1, -800, 2, 0.13],
    [1, 8, 0, 13],
    [-1, 8, 0, -13],
    [1, 200000000, 6, 0.000001],
    [-1, 200000000, 6, -0.000001],
    [-1, 100000, 2, 0],
    [1, 0, 2, null],
  ])(
    'rounds %s / %s × 100 to %s places as %s',
    (part, whole, decimals, expected) => {
      const rules = rulesFor({
        part: constant(part),
        whole: constant(whole),
        ratio: { type: 'percentage', part: 'part', whole: 'whole', decimals },
      });
      const record = generate(rules, 'percentage-rounding');
      expect(record.ratio).toBe(expected);
      expect(Object.is(record.ratio, -0)).toBe(false);
      expect(recordSchema(rules).parse(record)).toEqual(record);
    },
  );

  it('aggregates both percentage paths through arrays before dividing', () => {
    const rules = rulesFor({
      parts: { type: 'array', minItems: 3, maxItems: 3, items: constant(0.1) },
      wholes: { type: 'array', minItems: 2, maxItems: 2, items: constant(0.4) },
      ratio: {
        type: 'percentage',
        part: 'parts[]',
        whole: 'wholes[]',
        decimals: 2,
      },
    });
    const record = generate(rules, 'percentage-paths');
    expect(record.ratio).toBe(37.5);
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it('evaluates forward dependencies across sums and percentages without changing rule-file order', () => {
    const rules = rulesFor({
      final: { type: 'sum', of: ['ratio', 'subtotal'] },
      ratio: {
        type: 'percentage',
        part: 'subtotal',
        whole: 'whole',
        decimals: 2,
      },
      subtotal: { type: 'sum', of: ['a', 'b'] },
      a: constant(0.1),
      b: constant(0.2),
      whole: constant(0.8),
    });
    const record = generate(rules, 'forward-dependencies');
    expect(record).toEqual({
      final: 37.8,
      ratio: 37.5,
      subtotal: 0.3,
      a: 0.1,
      b: 0.2,
      whole: 0.8,
    });
    expect(Object.keys(record)).toEqual(Object.keys(rules.fields));
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it.each(['sum', 'percentage'] as const)(
    'blanks a %s independently and treats a blank derived dependency as zero without shifting other fields',
    type => {
      const base = rulesFor({
        before: money,
        after: money,
        whole: constant(2),
      });
      const derived: RuleField =
        type === 'sum'
          ? { type, of: ['before', 'after'] }
          : { type, part: 'before', whole: 'whole', decimals: 2 };
      const extended = rulesFor({
        derived: { ...derived, blankProbability: 0.5 },
        ...base.fields,
        dependent: { type: 'sum', of: ['derived'] },
      });
      const plain = rulesFor({ ...extended.fields, derived });
      let blanks = 0;
      let values = 0;
      for (const seed of seeds) {
        const record = generate(extended, seed);
        expect(record).toMatchObject(generate(base, seed));
        expect(recordSchema(extended).parse(record)).toEqual(record);
        if (record.derived === null) {
          blanks++;
          expect(record.dependent).toBe(0);
        } else {
          values++;
          expect(record.derived).toBe(generate(plain, seed).derived);
          expect(record.dependent).toBe(record.derived);
        }
      }
      expect(blanks).toBeGreaterThan(0);
      expect(values).toBeGreaterThan(0);
    },
  );

  it.each([
    [
      'sum',
      {
        huge: constant(1e16),
        tiny: constant(0.01),
        total: { type: 'sum', of: ['huge', 'tiny'] },
      },
      'total',
    ],
    [
      'percentage',
      {
        huge: constant(1e16),
        whole: constant(3),
        ratio: {
          type: 'percentage',
          part: 'huge',
          whole: 'whole',
          decimals: 2,
        },
      },
      'ratio',
    ],
  ] satisfies [string, Rules['fields'], string][])(
    'rejects an unprintable exact %s result at its rule-file field path',
    (_name, fields, key) => rejectsAt(rulesFor(fields), ['fields', key]),
  );

  it.each([
    ['self-reference', { a: { type: 'sum', of: ['a'] } }],
    [
      'mutual dependency',
      {
        a: { type: 'sum', of: ['b'] },
        b: { type: 'percentage', part: 'a', whole: 'one', decimals: 2 },
        one: constant(1),
      },
    ],
  ] satisfies [string, Rules['fields']][])(
    'rejects a derived %s as invalid rules at the originating field',
    (_name, fields) => rejectsAt(rulesFor(fields), ['fields', 'a']),
  );
});
