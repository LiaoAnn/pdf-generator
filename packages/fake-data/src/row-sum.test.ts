import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type RuleField,
  type Rules,
  rulesSchema,
} from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { generate, recordSchema } from './index.ts';

const constant = (value: number): RuleField => ({ type: 'constant', value });
const rulesFor = (fields: Rules['fields']): Rules =>
  rulesSchema.parse({ schemaVersion: 1, fields });
const array = (count: number, fields: Rules['fields']): RuleField => ({
  type: 'array',
  minItems: count,
  maxItems: count,
  items: { type: 'object', fields },
});

// Independent decimal oracle: parse printed digits, never add binary floats.
function cents(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== 'number') throw new Error('Expected money');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Not a cent amount: ${value}`);
  const magnitude =
    BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Expected object item');
    return item as Record<string, unknown>;
  });
}

describe('financial-detail row sums through the public engine', () => {
  it('CLI keeps each row subtotal and its forward-dependent grand total exact across 100 seeds, preserves blanks and replays bytes', () => {
    const money: RuleField = {
      type: 'money',
      min: -1000,
      max: 1000,
      decimals: 2,
      blankProbability: 0.3,
    };
    const rules = rulesFor({
      // Deliberately before its row-level dependency.
      grand: { type: 'sum', of: ['rows[].subtotal'] },
      rows: {
        type: 'array',
        minItems: 0,
        maxItems: 20,
        items: {
          type: 'object',
          fields: {
            subtotal: {
              type: 'sum',
              of: ['rows[].price', 'rows[].tax'],
              blankProbability: 0.25,
            },
            price: money,
            tax: money,
          },
        },
      },
    });
    const seeds = Array.from({ length: 100 }, (_, i) =>
      createHash('sha256').update(`T02-4-financial-detail\n${i}`).digest('hex'),
    );
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
    const lengths = new Set<number>();
    let blankInputs = 0;
    let blankTargets = 0;
    let filledTargets = 0;
    for (const record of records) {
      expect(recordSchema(rules).parse(record)).toEqual(record);
      const rows = objects(record.rows);
      lengths.add(rows.length);
      let grand = 0n;
      for (const row of rows) {
        if (row.price === null || row.tax === null) blankInputs++;
        if (row.subtotal === null) {
          blankTargets++;
        } else {
          filledTargets++;
          const subtotal = cents(row.price) + cents(row.tax);
          expect(row.subtotal).toBe(Number(subtotal) / 100);
          expect(Object.is(row.subtotal, -0)).toBe(false);
          grand += subtotal;
        }
      }
      expect(record.grand).toBe(Number(grand) / 100);
    }
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(20)).toBe(true);
    expect(blankInputs).toBeGreaterThan(0);
    expect(blankTargets).toBeGreaterThan(0);
    expect(filledTargets).toBeGreaterThan(0);
  });

  it.each([
    ['ancestor group', 'groups[].k'],
    ['current row', 'groups[].rows[].v'],
    ['sibling array in the current group', 'groups[].extra[].v'],
    ['descendant array in the current row', 'groups[].rows[].sub[].v'],
    ['mixed bound, unrelated-array and root paths', null],
  ])('binds only ancestor arrays when reading %s', (_name, path) => {
    const paths =
      path === null
        ? ['groups[].k', 'groups[].rows[].v', 'other[].v', 'base']
        : [path];
    const value: RuleField = { type: 'money', min: 1, max: 100, decimals: 2 };
    const rules = rulesFor({
      base: constant(0.1),
      other: array(4, { v: value }),
      groups: array(2, {
        k: value,
        extra: array(3, { v: value }),
        rows: array(3, {
          v: value,
          sub: array(2, { v: value }),
          // Duplicate paths must retain their arithmetic multiplicity.
          t: { type: 'sum', of: [...paths, ...paths] },
        }),
      }),
    });
    const record = generate(rules, 'nested-row-sum');
    expect(recordSchema(rules).parse(record)).toEqual(record);
    const sum = (items: unknown) =>
      objects(items).reduce((total, item) => total + cents(item.v), 0n);
    for (const group of objects(record.groups)) {
      for (const row of objects(group.rows)) {
        const expected =
          path === 'groups[].k'
            ? cents(group.k)
            : path === 'groups[].rows[].v'
              ? cents(row.v)
              : path === 'groups[].extra[].v'
                ? sum(group.extra)
                : path === 'groups[].rows[].sub[].v'
                  ? sum(row.sub)
                  : cents(group.k) +
                    cents(row.v) +
                    sum(record.other) +
                    cents(record.base);
        expect(row.t).toBe(Number(2n * expected) / 100);
      }
    }
  });
});
