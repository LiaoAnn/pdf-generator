import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { RuleField, Rules } from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { generate } from './index.ts';

type Row = Record<string, unknown> | null;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value.map(item => (item === null ? null : object(item)));
}

// Parse decimal digits independently: multiplying binary floats by 100 is not
// an exact oracle for balances (including negative balances).
function cents(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== 'number') throw new Error('Expected money');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Not a cent amount: ${value}`);
  const magnitude =
    BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}

function withoutSortBy(rules: Rules): Rules {
  const copy = structuredClone(rules);
  const visit = (field: RuleField) => {
    if (field.type === 'array') {
      delete field.sortBy;
      visit(field.items);
    } else if (field.type === 'object') {
      Object.values(field.fields).forEach(visit);
    }
  };
  Object.values(copy.fields).forEach(visit);
  return copy;
}

// Explicit draw-index tie breaker makes stability part of the oracle, even if
// the implementation switches away from JavaScript's stable Array.sort.
function sorted(draws: Row[], key = 'date'): Row[] {
  return draws
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row?.[key] ?? null;
      const right = b.row?.[key] ?? null;
      if (left === right) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      return String(left) < String(right) ? -1 : 1;
    })
    .map(({ row }) => row);
}

function drawnFields(row: Row): Row {
  if (row === null) return null;
  const {
    balance: _balance,
    charged: _charged,
    depositShare: _share,
    ...drawn
  } = row;
  return drawn;
}

const date: RuleField = {
  type: 'date',
  min: '2026-01-01',
  max: '2026-01-03',
};
const money: RuleField = { type: 'money', min: 0, max: 100, decimals: 2 };

describe('date-sorted arrays through the public engine', () => {
  it('CLI sorts 100 example statements before balances, preserves row sums and shares, and replays identical bytes', () => {
    const rules: Rules = JSON.parse(
      readFileSync(
        new URL('../../contract/examples/rules.valid.json', import.meta.url),
        'utf8',
      ),
    );
    const seeds = Array.from({ length: 100 }, (_, i) => `sort-example-${i}`);
    const script = `
      import { readFileSync } from 'node:fs';
      import { generate } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const { rules, control, seeds } = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(seeds.map(seed => ({
        record: generate(rules, seed), draw: generate(control, seed),
      }))));
    `;
    const run = () =>
      execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          input: JSON.stringify({
            rules,
            control: withoutSortBy(rules),
            seeds,
          }),
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    const bytes = run();
    expect(run()).toBe(bytes);
    const batch: {
      record: Record<string, unknown>;
      draw: Record<string, unknown>;
    }[] = JSON.parse(bytes);
    expect(batch).toHaveLength(100);
    const lengths = new Set(
      batch.map(({ draw }) => rows(draw.transactions).length),
    );
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(20)).toBe(true);
    expect(
      batch.some(({ draw }) => {
        const items = rows(draw.transactions);
        return JSON.stringify(items) !== JSON.stringify(sorted(items));
      }),
    ).toBe(true);

    for (const { record, draw } of batch) {
      const transactions = rows(record.transactions);
      expect(transactions.map(drawnFields)).toEqual(
        sorted(rows(draw.transactions)).map(drawnFields),
      );
      expect(record.totalDeposits).toBe(draw.totalDeposits);
      const deposits = transactions.reduce(
        (total, row) => total + cents(row?.deposit),
        0n,
      );
      expect(record.totalDeposits).toBe(Number(deposits) / 100);
      let balance = cents(record.openingBalance);
      for (const value of transactions) {
        const row = object(value);
        balance += cents(row.deposit) - cents(row.withdrawal);
        expect(row.balance).toBe(Number(balance) / 100);
        expect(row.charged).toBe(
          Number(cents(row.withdrawal) + cents(row.fee)) / 100,
        );
        const numerator = cents(row.deposit) * 10_000n;
        const share =
          deposits === 0n
            ? null
            : Number((2n * numerator + deposits) / (2n * deposits)) / 100;
        expect(row.depositShare).toBe(share);
      }
    }
  });

  it('moves whole rows in stable date order, keeping tied dates, blank dates and null items in draw order', () => {
    const rules: Rules = {
      schemaVersion: 1,
      fields: {
        rows: {
          type: 'array',
          minItems: 40,
          maxItems: 40,
          sortBy: 'posted',
          items: {
            type: 'object',
            blankProbability: 0.25,
            fields: {
              posted: { ...date, blankProbability: 0.3 },
              // An unrelated date catches sorting by a hard-coded field name.
              date: { type: 'date', min: '2025-01-01', max: '2025-12-31' },
              marker: { type: 'integer', min: 0, max: 1_000_000 },
              amount: money,
              detail: { type: 'object', fields: { text: { type: 'name' } } },
            },
          },
        },
      },
    };
    const control = withoutSortBy(rules);
    const cases = Array.from({ length: 10 }, (_, i) => {
      const seed = `sort-blanks-${i}`;
      return {
        draws: rows(generate(control, seed).rows),
        record: generate(rules, seed),
      };
    });
    const all = cases.flatMap(({ draws }) => draws);
    expect(all.some(row => row === null)).toBe(true);
    expect(all.some(row => row !== null && row.posted === null)).toBe(true);
    expect(
      cases.some(({ draws }) =>
        draws.some(
          (row, i) =>
            row?.posted != null &&
            draws.slice(0, i).some(previous => previous?.posted == null),
        ),
      ),
    ).toBe(true);
    expect(
      cases.some(({ draws }) =>
        draws.some(
          (row, i) =>
            row?.posted != null &&
            draws
              .slice(0, i)
              .some(
                previous =>
                  previous !== null &&
                  previous.posted === row.posted &&
                  previous.marker !== row.marker,
              ),
        ),
      ),
    ).toBe(true);
    expect(
      cases.some(
        ({ draws }) =>
          JSON.stringify(draws) !== JSON.stringify(sorted(draws, 'posted')),
      ),
    ).toBe(true);
    for (const { draws, record } of cases) {
      expect(record.rows).toEqual(sorted(draws, 'posted'));
    }
  });

  it('sorts nested arrays within their own sorted parent and calculates balances using that parent opening', () => {
    const lines: RuleField = {
      type: 'array',
      minItems: 12,
      maxItems: 12,
      sortBy: 'date',
      items: {
        type: 'object',
        fields: {
          date,
          deposit: money,
          withdrawal: money,
          balance: {
            type: 'runningBalance',
            opening: 'accounts[].opening',
            add: ['accounts[].lines[].deposit'],
            subtract: ['accounts[].lines[].withdrawal'],
          },
        },
      },
    };
    const rules: Rules = {
      schemaVersion: 1,
      fields: {
        accounts: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          sortBy: 'date',
          items: {
            type: 'object',
            fields: {
              date,
              opening: money,
              lines,
              empty: {
                ...lines,
                minItems: 0,
                maxItems: 0,
                items: { type: 'object', fields: { date } },
              },
              absent: {
                ...lines,
                blankProbability: 1,
                items: { type: 'object', fields: { date } },
              },
            },
          },
        },
      },
    };
    const seed = 'sort-nested';
    const draw = generate(withoutSortBy(rules), seed);
    const record = generate(rules, seed);
    const accounts = rows(record.accounts).map(object);
    // Null and empty arrays must survive the recursive sort traversal.
    for (const account of accounts) {
      expect(account.empty).toEqual([]);
      expect(account.absent).toBeNull();
    }
    const drawnAccounts = rows(draw.accounts);
    expect(drawnAccounts).not.toEqual(sorted(drawnAccounts));
    expect(
      drawnAccounts.some(account => {
        const items = rows(account?.lines);
        return JSON.stringify(items) !== JSON.stringify(sorted(items));
      }),
    ).toBe(true);
    const expected = sorted(drawnAccounts).map(value => {
      const account = object(value);
      return {
        ...account,
        lines: sorted(rows(account.lines)).map(drawnFields),
      };
    });
    expect(
      accounts.map(account => ({
        ...account,
        lines: rows(account.lines).map(drawnFields),
      })),
    ).toEqual(expected);
    for (const account of accounts) {
      let balance = cents(account.opening);
      for (const value of rows(account.lines)) {
        const row = object(value);
        balance += cents(row.deposit) - cents(row.withdrawal);
        expect(row.balance).toBe(Number(balance) / 100);
      }
    }
    expect(generate(rules, seed)).toEqual(record);
  });
});
