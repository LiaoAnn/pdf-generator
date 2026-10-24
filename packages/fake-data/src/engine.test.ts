import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type RuleField,
  type Rules,
  rulesSchema,
} from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import {
  generate,
  InvalidRulesError,
  InvalidSeedError,
  isCalendarDate,
  isValidAddress,
  isValidBusinessId,
  isValidNationalId,
  isValidPhone,
  recordSchema,
  UnsupportedRuleError,
} from './index.ts';

const rules: Rules = {
  schemaVersion: 1,
  fields: {
    holder: { type: 'name', blankProbability: 0 },
    femaleId: { type: 'nationalId', gender: 'female' },
    maleId: { type: 'nationalId', gender: 'male' },
    businessId: { type: 'businessId' },
    company: { type: 'company' },
    address: { type: 'address', cities: ['臺北市'] },
    mobile: { type: 'phone', kind: 'mobile' },
    landline: { type: 'phone', kind: 'landline' },
    period: { type: 'date', min: '2024-02-28', max: '2024-03-01' },
    amount: { type: 'money', min: 0, max: 100, decimals: 2 },
    wholeDollars: { type: 'money', min: 10, max: 20 },
    count: { type: 'integer', min: -10, max: 10 },
    rate: { type: 'number', min: -1, max: 1, decimals: 3 },
    choice: { type: 'choice', options: [1, true, 'TWD'] },
    weighted: { type: 'choice', options: ['yes', 'no'], weights: [1, 0] },
    currency: { type: 'constant', value: 'TWD' },
    account: {
      type: 'object',
      fields: { limit: { type: 'money', min: 100, max: 999 } },
    },
    rows: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: {
        type: 'object',
        fields: {
          amount: { type: 'money', min: 0, max: 50, decimals: 2 },
          reference: { type: 'integer', min: 1, max: 1000000 },
        },
      },
    },
    empty: { type: 'array', minItems: 0, maxItems: 0, items: { type: 'name' } },
  },
};
const seed = 'T05_slice-4';
const example = (kind: 'valid' | 'invalid'): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../contract/examples/rules.${kind}.json`, import.meta.url),
      'utf8',
    ),
  );
const oneField = (field: RuleField): Rules => ({
  schemaVersion: 1,
  fields: { value: field },
});
function caught(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the public API to reject the input');
}

// Independent checksum oracles: no production validators or generator helpers.
function nationalChecksum(id: string): number {
  const letterOrder = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const code = letterOrder.indexOf(id.charAt(0)) + 10;
  const digits = `${code}${id.slice(1)}`;
  return (
    [...digits].reduce(
      (sum, digit, i) =>
        sum + Number(digit) * ([1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1][i] ?? 0),
      0,
    ) % 10
  );
}
function businessChecksum(id: string): boolean {
  const sum = [...id].reduce((total, digit, i) => {
    const product = Number(digit) * ([1, 2, 1, 2, 1, 2, 4, 1][i] ?? 0);
    return total + Math.floor(product / 10) + (product % 10);
  }, 0);
  return sum % 5 === 0 || (id.charAt(6) === '7' && (sum + 1) % 5 === 0);
}

describe('public fake-data engine', () => {
  it('replays byte-identical JSON across processes and preserves rule-file key order', () => {
    const script = `
      import { readFileSync } from 'node:fs';
      import { generate } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      process.stdout.write(JSON.stringify(generate(JSON.parse(readFileSync(0, 'utf8')), ${JSON.stringify(seed)})));
    `;
    const run = () =>
      execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          input: JSON.stringify(rules),
          encoding: 'utf8',
        },
      );
    const first = run();
    const second = run();
    const sha256 = (json: string) =>
      createHash('sha256').update(json).digest('hex');
    expect(sha256(first)).toBe(sha256(second));
    expect(first).toBe(second);
    expect(Object.keys(JSON.parse(first))).toEqual(Object.keys(rules.fields));
    expect(Object.keys(JSON.parse(first).rows[0])).toEqual([
      'amount',
      'reference',
    ]);
    expect(recordSchema(rules).parse(JSON.parse(first))).toEqual(
      JSON.parse(first),
    );
  });

  it('builds valid supported fields and changes the record for another seed', () => {
    const record = generate(rules, seed);
    expect(record).toEqual(generate(rules, seed));
    expect(generate(rules, 'another-seed')).not.toEqual(record);
    expect(recordSchema(rules).parse(record)).toEqual(record);
    for (const [key, gender] of [
      ['femaleId', '2'],
      ['maleId', '1'],
    ]) {
      const id = String(record[key ?? '']);
      expect(id.charAt(1)).toBe(gender);
      expect(isValidNationalId(id)).toBe(true);
      expect(nationalChecksum(id)).toBe(0);
    }
    expect(isValidBusinessId(String(record.businessId))).toBe(true);
    expect(businessChecksum(String(record.businessId))).toBe(true);
    expect(isValidAddress(String(record.address), ['臺北市'])).toBe(true);
    expect(isValidPhone(String(record.mobile), 'mobile')).toBe(true);
    expect(isValidPhone(String(record.landline), 'landline')).toBe(true);
    expect(isCalendarDate(String(record.period))).toBe(true);
    expect(record.weighted).toBe('yes');
    expect(record.empty).toEqual([]);
  });

  it('keeps root, nested and array-item streams stable when siblings are added or removed', () => {
    const baseline = generate(rules, seed);
    const extended = structuredClone(rules);
    extended.fields = { added: { type: 'name' }, ...extended.fields };
    const account = extended.fields.account;
    const rows = extended.fields.rows;
    if (
      account?.type !== 'object' ||
      rows?.type !== 'array' ||
      rows.items.type !== 'object'
    ) {
      throw new Error('The fixture must contain an account and object rows');
    }
    account.fields = { added: { type: 'name' }, ...account.fields };
    rows.items.fields = { added: { type: 'name' }, ...rows.items.fields };
    expect(generate(extended, seed)).toMatchObject(baseline);
    const { holder: _removed, ...remaining } = rules.fields;
    const { holder: _value, ...expected } = baseline;
    expect(generate({ ...rules, fields: remaining }, seed)).toEqual(expected);
  });

  it('reports only filler text and derived fields as unsupported in the contract example', () => {
    const error = caught(() => generate(example('valid'), seed));
    expect(error).toBeInstanceOf(UnsupportedRuleError);
    expect(error).toMatchObject({
      ticket: 'T12',
      unsupported: [
        { path: 'memo', feature: 'filler text' },
        { path: 'transactions[].balance', feature: 'derived field' },
        { path: 'totalDeposits', feature: 'derived field' },
        { path: 'utilization', feature: 'derived field' },
      ],
    });
    expect(error.message).toContain('not supported yet (T12)');
    for (const path of [
      'memo',
      'transactions[].balance',
      'totalDeposits',
      'utilization',
    ]) {
      expect(error.message).toContain(path);
    }
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, fields: rules.fields },
    example('invalid'),
  ])('rejects invalid rules before feature support checks: %j', input => {
    const error = caught(() => generate(input, seed));
    expect(error).toBeInstanceOf(InvalidRulesError);
    expect(error).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: expect.any(Array),
          message: expect.any(String),
        }),
      ]),
    });
  });
  it.each(['', 'has space', '台灣', 'a'.repeat(65), 'line\nbreak'])(
    'rejects invalid seed %j before unsupported features',
    input => {
      expect(caught(() => generate(example('valid'), input))).toBeInstanceOf(
        InvalidSeedError,
      );
    },
  );

  it.each([
    [{ type: 'date', min: '2026-02-30', max: '2026-03-01' }, 'min'],
    [{ type: 'date', min: '2026-02-01', max: '2026-02-30' }, 'max'],
    [{ type: 'money', min: 0.001, max: 0.002, decimals: 2 }, 'min'],
    [{ type: 'number', min: 0.001, max: 0.002, decimals: 2 }, 'min'],
  ] satisfies [RuleField, string][])(
    'reports impossible rule bounds at their rule-file path: %j',
    (field, bound) => {
      const error = caught(() => generate(oneField(field), seed));
      expect(error).toBeInstanceOf(InvalidRulesError);
      expect(error).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ['fields', 'value', bound],
            message: expect.any(String),
          }),
        ]),
      });
    },
  );
});

describe('recordSchema protects fixture data from tampering', () => {
  const tampering: [string, string, unknown][] = [
    ['wrong national check digit', 'femaleId', 'A223456810'],
    ['wrong national gender', 'femaleId', 'A123456789'],
    ['wrong business check digit', 'businessId', '00000001'],
    ['money outside bounds', 'amount', 101],
    ['money excess decimals', 'amount', 1.001],
    ['money default decimals', 'wholeDollars', 10.5],
    ['number excess decimals', 'rate', 0.0001],
    ['non-finite number', 'rate', Infinity],
    ['fractional integer', 'count', 1.5],
    ['choice with coerced type', 'choice', '1'],
    ['changed constant', 'currency', 'USD'],
    ['extra root key', 'extra', true],
    ['missing key', 'holder', undefined],
    ['forbidden null', 'holder', null],
    ['short array', 'rows', []],
    ['long array', 'empty', ['王小明']],
    ['extra nested key', 'account', { limit: 100, extra: true }],
    ['missing nested key', 'account', {}],
    [
      'invalid array item',
      'rows',
      [
        { amount: -1, reference: 1 },
        { amount: 1, reference: 2 },
      ],
    ],
    ['postal mismatch', 'address', '999臺北市中正區中山路1號'],
    ['city outside filter', 'address', '220新北市板橋區中山路1號'],
    ['wrong phone kind', 'mobile', '02-2345-6789'],
    ['impossible calendar day', 'period', '2024-02-30'],
    ['date outside bounds', 'period', '2025-01-01'],
    ['non-CJK name', 'holder', 'Alice'],
    ['wrong company suffix', 'company', '台灣公司'],
  ];
  it.each(tampering)('rejects %s', (_name, key, value) => {
    const record: Record<string, unknown> = structuredClone(
      generate(rules, seed),
    );
    if (value === undefined) delete record[key];
    else record[key] = value;
    expect(recordSchema(rules).safeParse(record).success).toBe(false);
  });

  it('accepts nullable T12 values and validates their non-null variants without generating them', () => {
    const nullable = oneField({
      type: 'text',
      lang: 'zh',
      minLength: 2,
      maxLength: 4,
      blankProbability: 0.5,
    });
    const schema = recordSchema(nullable);
    expect(schema.safeParse({ value: null }).success).toBe(true);
    expect(schema.safeParse({ value: '台灣' }).success).toBe(true);
    expect(schema.safeParse({ value: '' }).success).toBe(false);
    expect(schema.safeParse({ value: '台灣測試文字' }).success).toBe(false);
    expect(schema.safeParse({ value: false }).success).toBe(false);
  });

  it('validates T12 booleans, ranged arrays and finite derived numbers without generation', () => {
    const fields: Rules['fields'] = {
      checked: { type: 'checkbox' },
      rows: {
        type: 'array',
        minItems: 0,
        maxItems: 2,
        items: { type: 'integer', min: 0, max: 10 },
      },
      total: { type: 'sum', of: ['rows[]'] },
      balance: {
        type: 'runningBalance',
        opening: 'total',
        add: [],
        subtract: [],
      },
      ratio: {
        type: 'percentage',
        part: 'total',
        whole: 'balance',
        decimals: 2,
      },
    };
    const schema = recordSchema(
      rulesSchema.parse({ schemaVersion: 1, fields }),
    );
    const record = {
      checked: true,
      rows: [1],
      total: 1,
      balance: 1,
      ratio: 100,
    };
    expect(schema.safeParse(record).success).toBe(true);
    expect(schema.safeParse({ ...record, rows: [] }).success).toBe(true);
    expect(schema.safeParse({ ...record, rows: [1, 2, 3] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...record, checked: 1 }).success).toBe(false);
    for (const key of ['total', 'balance', 'ratio']) {
      expect(schema.safeParse({ ...record, [key]: Infinity }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...record, [key]: NaN }).success).toBe(false);
    }
  });
});
