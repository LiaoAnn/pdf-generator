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
  createHash('sha256').update(`T12-bank-statement\n${index}`).digest('hex'),
);
const constant = (value: number): RuleField => ({ type: 'constant', value });
const rulesFor = (fields: Rules['fields']): Rules =>
  rulesSchema.parse({ schemaVersion: 1, fields });
const array = (fields: Rules['fields'], count = 3): RuleField => ({
  type: 'array',
  minItems: count,
  maxItems: count,
  items: { type: 'object', fields },
});
const balance: RuleField = {
  type: 'runningBalance',
  opening: 'opening',
  add: ['rows[].deposit'],
  subtract: ['rows[].withdrawal'],
};
const balancePath = ['fields', 'rows', 'items', 'fields', 'balance'];

// Independent oracle: read printed decimal digits, never scale a binary float.
function cents(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== 'number') throw new Error('Expected money');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Not a cent amount: ${value}`);
  const magnitude =
    BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected rows');
  return value;
}
function rejectsAt(rules: Rules, prefix = balancePath) {
  let caught: unknown;
  try {
    generate(rules, 'invalid-balance');
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

describe('bank statement running balances through the public engine', () => {
  it('CLI keeps every balance and total exact across 100 batch seeds, varies rows and checkboxes, and replays JSON bytes', () => {
    const money: RuleField = {
      type: 'money',
      min: 0,
      max: 1000,
      decimals: 2,
      blankProbability: 0.3,
    };
    const rules = rulesFor({
      opening: { ...money, blankProbability: 0.2 },
      rows: {
        type: 'array',
        minItems: 0,
        maxItems: 20,
        items: {
          type: 'object',
          fields: {
            date: { type: 'date', min: '2026-01-01', max: '2026-12-31' },
            deposit: money,
            withdrawal: money,
            balance,
          },
        },
      },
      paperless: { type: 'checkbox', probability: 0.7 },
      totalDeposits: { type: 'sum', of: ['rows[].deposit'] },
      totalWithdrawals: { type: 'sum', of: ['rows[].withdrawal'] },
    });
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
    let checked = 0;
    let blankAmounts = 0;
    let blankOpenings = 0;
    for (const record of records) {
      expect(recordSchema(rules).parse(record)).toEqual(record);
      const transactions = rows(record.rows);
      lengths.add(transactions.length);
      expect(typeof record.paperless).toBe('boolean');
      if (record.paperless) checked++;
      if (record.opening === null) blankOpenings++;
      let running = cents(record.opening);
      let deposits = 0n;
      let withdrawals = 0n;
      for (const value of transactions) {
        const row = object(value);
        deposits += cents(row.deposit);
        withdrawals += cents(row.withdrawal);
        running += cents(row.deposit) - cents(row.withdrawal);
        expect(row.balance).toBe(Number(running) / 100);
        expect(Object.is(row.balance, -0)).toBe(false);
        if (row.deposit === null || row.withdrawal === null) blankAmounts++;
      }
      expect(record.totalDeposits).toBe(Number(deposits) / 100);
      expect(record.totalWithdrawals).toBe(Number(withdrawals) / 100);
    }
    expect(lengths.size).toBeGreaterThan(3);
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(20)).toBe(true);
    expect(checked / records.length).toBeGreaterThan(0);
    expect(checked / records.length).toBeLessThan(1);
    expect(blankAmounts).toBeGreaterThan(0);
    expect(blankOpenings).toBeGreaterThan(0);
  });

  it('uses the innermost rows, scopes ancestor arrays to the current account and sums deeper and unrelated arrays', () => {
    const rules = rulesFor({
      reserve: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: constant(0.1),
      },
      accounts: array(
        {
          opening: { type: 'money', min: 1, max: 10, decimals: 2 },
          lines: array({
            detail: {
              type: 'object',
              fields: {
                balance: {
                  type: 'runningBalance',
                  opening: 'accounts[].opening',
                  add: [
                    'accounts[].lines[].credits[].amount',
                    'accounts[].lines[].bonus',
                  ],
                  subtract: [
                    'accounts[].lines[].debit',
                    'accounts[].lines[].fee',
                  ],
                },
              },
            },
            credits: array({ amount: constant(0.1) }, 2),
            bonus: constant(0.05),
            debit: constant(0.03),
            fee: constant(0.02),
          }),
          externalOpening: { type: 'sum', of: ['reserve[]'] },
          otherLines: array(
            {
              balance: {
                type: 'runningBalance',
                opening: 'reserve[]',
                add: ['accounts[].otherLines[].amount'],
                subtract: [],
              },
              amount: constant(0.01),
            },
            2,
          ),
        },
        2,
      ),
    });
    const record = generate(rules, 'nested-running-balance');
    const openings = new Set<number>();
    for (const value of rows(record.accounts)) {
      const account = object(value);
      openings.add(Number(account.opening));
      let expected = cents(account.opening);
      for (const value of rows(account.lines)) {
        const line = object(value);
        expected += 20n;
        expect(object(line.detail).balance).toBe(Number(expected) / 100);
      }
      expect(
        rows(account.otherLines).map(value => object(value).balance),
      ).toEqual([0.21, 0.22]);
    }
    expect(openings.size).toBe(2);
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it('continues through blank balances and null rows while null openings and amounts count as zero', () => {
    const rules = rulesFor({
      opening: { ...constant(9), blankProbability: 1 },
      rows: {
        type: 'array',
        minItems: 20,
        maxItems: 20,
        items: {
          type: 'object',
          blankProbability: 0.3,
          fields: {
            deposit: constant(0.1),
            withdrawal: { ...constant(9), blankProbability: 1 },
            balance: { ...balance, blankProbability: 0.4 },
          },
        },
      },
    });
    let nullRows = 0;
    let resumedAfterBlank = 0;
    for (const seed of seeds.slice(0, 10)) {
      const record = generate(rules, seed);
      let running = 0n;
      let skippedBalance = false;
      for (const value of rows(record.rows)) {
        if (value === null) {
          nullRows++;
          continue;
        }
        const row = object(value);
        running += 10n;
        expect(row.withdrawal).toBeNull();
        if (row.balance === null) skippedBalance = true;
        else {
          expect(row.balance).toBe(Number(running) / 100);
          if (skippedBalance) resumedAfterBlank++;
        }
      }
      expect(recordSchema(rules).parse(record)).toEqual(record);
    }
    expect(nullRows).toBeGreaterThan(0);
    expect(resumedAfterBlank).toBeGreaterThan(0);
  });

  it('orders forward derived dependencies before running balances and consumers after them', () => {
    const rules = rulesFor({
      totalBalances: { type: 'sum', of: ['rows[].balance'] },
      rows: array({
        balance,
        deposit: {
          type: 'percentage',
          part: 'part',
          whole: 'whole',
          decimals: 2,
        },
        withdrawal: constant(0.01),
      }),
      opening: { type: 'sum', of: ['initial'] },
      initial: constant(0.1),
      part: constant(1),
      whole: constant(1000),
    });
    const record = generate(rules, 'forward-running-balance');
    expect(rows(record.rows).map(value => object(value).balance)).toEqual([
      0.19, 0.28, 0.37,
    ]);
    expect(record.totalBalances).toBe(0.84);
    expect(recordSchema(rules).parse(record)).toEqual(record);
  });

  it('prints exact cancellation as positive zero', () => {
    const rules = rulesFor({
      opening: constant(-0.1),
      rows: array(
        {
          deposit: constant(0.1),
          withdrawal: constant(0),
          balance,
        },
        1,
      ),
    });
    const record = generate(rules, 'zero-balance');
    const value = object(rows(record.rows)[0]).balance;
    expect(value).toBe(0);
    expect(Object.is(value, -0)).toBe(false);
  });

  it('rejects an exact balance that no JS number can print at the balance rule path', () => {
    rejectsAt(
      rulesFor({
        opening: constant(1e16),
        rows: array(
          {
            deposit: constant(0.01),
            withdrawal: constant(0),
            balance,
          },
          1,
        ),
      }),
    );
  });

  it('rejects a running balance outside any array item at its rule path', () => {
    rejectsAt(
      rulesFor({
        opening: constant(1),
        balance: {
          type: 'runningBalance',
          opening: 'opening',
          add: [],
          subtract: [],
        },
      }),
      ['fields', 'balance'],
    );
  });

  it.each(['add', 'subtract'] as const)(
    'rejects %s paths that bypass the balance rows array',
    key => {
      rejectsAt(
        rulesFor({
          opening: constant(1),
          other: array({ amount: constant(1) }),
          rows: array(
            {
              deposit: constant(0.1),
              withdrawal: constant(0),
              balance: { ...balance, [key]: ['other[].amount'] },
            },
            0,
          ),
        }),
      );
    },
  );

  it('rejects an opening path through the balance rows even when every row is blank', () => {
    rejectsAt(
      rulesFor({
        opening: constant(1),
        rows: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            blankProbability: 1,
            fields: {
              deposit: constant(0.1),
              withdrawal: constant(0),
              balance: { ...balance, opening: 'rows[].deposit' },
            },
          },
        },
      }),
    );
  });

  it.each(['direct', 'through another derived field'] as const)(
    'rejects a balance cycle %s at its rule path',
    kind => {
      rejectsAt(
        rulesFor({
          opening: constant(1),
          rows: array({
            deposit: constant(0.1),
            withdrawal: constant(0),
            balance: {
              ...balance,
              add: [kind === 'direct' ? 'rows[].balance' : 'rows[].copy'],
            },
            copy: { type: 'sum', of: ['rows[].balance'] },
          }),
        }),
      );
    },
  );
});
