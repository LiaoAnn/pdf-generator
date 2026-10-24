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

// Independent decimal-digit and integer quotient/remainder oracle.
function cents(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== 'number') throw new Error('Expected money');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Not a cent amount: ${value}`);
  const magnitude =
    BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}
function percent(part: bigint, whole: bigint, decimals = 2): number | null {
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
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Expected object item');
    return item as Record<string, unknown>;
  });
}

describe('financial-detail row percentages through the public engine', () => {
  it('CLI computes each row share and tax rate before their consumer across 100 seeds, preserves blanks and replays bytes', () => {
    const money: RuleField = {
      type: 'money',
      min: -1000,
      max: 1000,
      decimals: 2,
      blankProbability: 0.3,
    };
    const rules = rulesFor({
      shares: { type: 'sum', of: ['rows[].share'] },
      total: { type: 'sum', of: ['rows[].amount'] },
      rows: {
        type: 'array',
        minItems: 0,
        maxItems: 20,
        items: {
          type: 'object',
          fields: {
            share: {
              type: 'percentage',
              part: 'rows[].amount',
              whole: 'total',
              decimals: 2,
              blankProbability: 0.25,
            },
            rate: {
              type: 'percentage',
              part: 'rows[].tax',
              whole: 'rows[].subtotal',
              decimals: 2,
            },
            subtotal: { type: 'sum', of: ['rows[].amount', 'rows[].tax'] },
            amount: money,
            tax: money,
          },
        },
      },
    });
    const seeds = Array.from({ length: 100 }, (_, i) =>
      createHash('sha256').update(`T02-4-row-percentage\n${i}`).digest('hex'),
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
    let blankTargets = 0;
    let filledTargets = 0;
    let nullInputs = 0;
    let zeroWholes = 0;
    for (const [index, record] of records.entries()) {
      const control = structuredClone(rules);
      const field = control.fields.rows;
      if (field?.type !== 'array' || field.items.type !== 'object')
        throw new Error('Expected row rules');
      field.items.fields.share = {
        type: 'percentage',
        part: 'total',
        whole: 'total',
        decimals: 2,
        blankProbability: 0.25,
      };
      const controlRows = objects(generate(control, seeds[index] ?? '').rows);
      expect(recordSchema(rules).parse(record)).toEqual(record);
      const rows = objects(record.rows);
      lengths.add(rows.length);
      const total = rows.reduce((sum, row) => sum + cents(row.amount), 0n);
      expect(record.total).toBe(Number(total) / 100);
      let shares = 0n;
      for (const [rowIndex, row] of rows.entries()) {
        // Same target path/blank draw, with a non-row-scoped calculation.
        if (total !== 0n)
          expect(row.share === null).toBe(
            controlRows[rowIndex]?.share === null,
          );
        if (row.amount === null || row.tax === null) nullInputs++;
        if (row.share === null) blankTargets++;
        else {
          filledTargets++;
          expect(row.share).toBe(percent(cents(row.amount), total));
          shares += cents(row.share);
        }
        const subtotal = cents(row.amount) + cents(row.tax);
        if (subtotal === 0n) zeroWholes++;
        expect(row.rate).toBe(percent(cents(row.tax), subtotal));
        expect(Object.is(row.rate, -0)).toBe(false);
      }
      expect(record.shares).toBe(Number(shares) / 100);
    }
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(20)).toBe(true);
    expect(blankTargets).toBeGreaterThan(0);
    expect(filledTargets).toBeGreaterThan(0);
    expect(nullInputs).toBeGreaterThan(0);
    expect(zeroWholes).toBeGreaterThan(0);
  });

  it.each([
    ['ancestor group', 'groups[].k', 'base'],
    ['current row denominator only', 'base', 'groups[].rows[].v'],
    ['sibling array denominator', 'groups[].rows[].v', 'groups[].extra[].v'],
    ['descendant array numerator', 'groups[].rows[].sub[].v', 'groups[].k'],
    ['unrelated array denominator', 'groups[].rows[].v', 'other[].v'],
  ])('binds only the target ancestors for %s', (_name, part, whole) => {
    const value: RuleField = { type: 'money', min: 1, max: 100, decimals: 2 };
    const rules = rulesFor({
      base: constant(7),
      other: array(4, { v: value }),
      groups: array(2, {
        k: value,
        extra: array(3, { v: value }),
        rows: array(3, {
          v: value,
          sub: array(2, { v: value }),
          ratio: { type: 'percentage', part, whole, decimals: 2 },
        }),
      }),
    });
    const record = generate(rules, 'nested-row-percentage');
    const sum = (items: unknown) =>
      objects(items).reduce((s, item) => s + cents(item.v), 0n);
    for (const group of objects(record.groups)) {
      for (const row of objects(group.rows)) {
        const read = (path: string): bigint => {
          switch (path) {
            case 'base':
              return cents(record.base);
            case 'groups[].k':
              return cents(group.k);
            case 'groups[].rows[].v':
              return cents(row.v);
            case 'groups[].extra[].v':
              return sum(group.extra);
            case 'groups[].rows[].sub[].v':
              return sum(row.sub);
            case 'other[].v':
              return sum(record.other);
            default:
              throw new Error(`Unexpected oracle path: ${path}`);
          }
        };
        expect(row.ratio).toBe(percent(read(part), read(whole)));
      }
    }
  });

  it('preserves pre-slice bytes when percentages read only unrelated arrays or root fields', () => {
    const value: RuleField = { type: 'money', min: 1, max: 100, decimals: 2 };
    const rules = rulesFor({
      base: constant(7),
      other: array(4, { v: value }),
      rows: array(3, {
        v: value,
        ratio: {
          type: 'percentage',
          part: 'other[].v',
          whole: 'base',
          decimals: 2,
        },
      }),
      ratio: {
        type: 'percentage',
        part: 'rows[].v',
        whole: 'other[].v',
        decimals: 2,
      },
    });
    const bytes = JSON.stringify(
      Array.from({ length: 100 }, (_, i) =>
        generate(rules, `unbound-percentage-${i}`),
      ),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'f89bcd74d1a876ed82c6b0872d1b6bd426bafb67b8fabd5576046a7368710c38',
    );
  });

  it('treats blank row denominators as zero without poisoning populated rows', () => {
    const rules = rulesFor({
      part: constant(1),
      rows: array(20, {
        whole: { ...constant(800), blankProbability: 0.5 },
        ratio: {
          type: 'percentage',
          part: 'part',
          whole: 'rows[].whole',
          decimals: 2,
        },
      }),
    });
    const rows = objects(generate(rules, 'blank-row-denominator').rows);
    expect(rows.some(row => row.whole === null)).toBe(true);
    expect(rows.some(row => row.whole !== null)).toBe(true);
    for (const row of rows)
      expect(row.ratio).toBe(row.whole === null ? null : 0.13);
  });

  it.each([1, -1])(
    'rounds row-scoped signed ties away from zero for part %s',
    part => {
      const rules = rulesFor({
        whole: constant(800),
        rows: array(2, {
          amount: constant(part),
          share: {
            type: 'percentage',
            part: 'rows[].amount',
            whole: 'whole',
            decimals: 2,
          },
        }),
      });
      for (const row of objects(generate(rules, 'row-tie').rows))
        expect(row.share).toBe(part * 0.13);
    },
  );
});
