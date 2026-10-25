import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import {
  contractSchemas,
  type RuleField,
  type Rules,
  rulesSchema,
  taiwanCities,
} from './index.ts';

function example(kind: 'valid' | 'invalid'): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../examples/rules.${kind}.json`, import.meta.url),
      'utf8',
    ),
  );
}

function document(field: unknown) {
  return { schemaVersion: 1, fields: { value: field } };
}

function expectIssue(input: unknown, path: (string | number)[]) {
  const result = rulesSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map(issue => issue.path)).toContainEqual(path);
  }
}

describe('rules consumed by the seeded data engine', () => {
  test('bank statement round-trips every variant without defaults or transforms', () => {
    const input = example('valid');
    expect(input).toHaveProperty('fields.transactions.sortBy', 'date');
    expect(rulesSchema.parse(input)).toEqual(input);
    const minimal = document({ type: 'name' });
    expect(rulesSchema.parse(minimal)).toEqual(minimal);
    expectTypeOf<Rules>().toEqualTypeOf<z.infer<typeof rulesSchema>>();
    expectTypeOf<Rules['fields'][string]>().toEqualTypeOf<RuleField>();
  });

  test('rules are registered so the shared export suite reaches local consumers', () => {
    expect(contractSchemas).toHaveProperty('rules', rulesSchema);
  });

  test('invalid fixture differs only by a missing phone kind', () => {
    const invalid = example('invalid');
    const valid = example('valid') as Rules;
    // The invalid fixture keeps legacy text and array settings; only the valid
    // fixture demonstrates pack phrases and date sorting.
    const transactions = { ...valid.fields.transactions };
    Reflect.deleteProperty(transactions, 'sortBy');
    const memo = { ...valid.fields.memo };
    Reflect.deleteProperty(memo, 'phrases');
    expect(invalid).toEqual({
      ...valid,
      fields: {
        ...valid.fields,
        transactions,
        memo,
        mobile: { type: 'phone' },
      },
    });
    const result = rulesSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path)).toEqual([
        ['fields', 'mobile', 'kind'],
      ]);
    }
  });

  test.each([
    ['root', { ...document({ type: 'name' }), typo: true }],
    ['field', document({ type: 'name', typo: true })],
    [
      'nested object',
      document({
        type: 'object',
        fields: { child: { type: 'company', typo: true } },
      }),
    ],
    [
      'array item',
      document({
        type: 'array',
        minItems: 0,
        maxItems: 1,
        items: { type: 'checkbox', typo: true },
      }),
    ],
  ])(
    'rejects unknown keys at %s instead of silently losing typos',
    (_label, input) => {
      expect(rulesSchema.safeParse(input).success).toBe(false);
    },
  );

  test.each([
    { schemaVersion: '1', fields: { value: { type: 'name' } } },
    { schemaVersion: 2, fields: { value: { type: 'name' } } },
    { schemaVersion: 1, fields: {} },
    document({ type: 'object', fields: {} }),
    ...['', '1name', 'first-name', 'name.part', '姓名'].map(key => ({
      schemaVersion: 1,
      fields: { [key]: { type: 'name' } },
    })),
  ])('rejects unsupported versions and unusable field maps: %j', input => {
    expect(rulesSchema.safeParse(input).success).toBe(false);
  });

  test('preserves Handlebars identifiers in nested maps', () => {
    const input = {
      schemaVersion: 1,
      fields: {
        _account2: { type: 'object', fields: { Name_1: { type: 'name' } } },
      },
    };
    expect(rulesSchema.parse(input)).toEqual(input);
  });

  test('accepts all official city names in their public order and rejects aliases', () => {
    const cities = [
      '臺北市',
      '新北市',
      '桃園市',
      '臺中市',
      '臺南市',
      '高雄市',
      '基隆市',
      '新竹市',
      '嘉義市',
      '新竹縣',
      '苗栗縣',
      '彰化縣',
      '南投縣',
      '雲林縣',
      '嘉義縣',
      '屏東縣',
      '宜蘭縣',
      '花蓮縣',
      '臺東縣',
      '澎湖縣',
      '金門縣',
      '連江縣',
    ];
    expect(taiwanCities).toEqual(cities);
    expect(
      rulesSchema.safeParse(document({ type: 'address', cities })).success,
    ).toBe(true);
    for (const cities of [[], ['台北市'], ['臺北縣']]) {
      expect(
        rulesSchema.safeParse(document({ type: 'address', cities })).success,
      ).toBe(false);
    }
  });

  test.each([
    { type: 'name', gender: 'unknown' },
    { type: 'phone', kind: 'fax' },
    { type: 'name', description: 1 },
    { type: 'company', blankProbability: -0.01 },
    { type: 'company', blankProbability: 1.01 },
    { type: 'checkbox', probability: -0.01 },
    { type: 'checkbox', probability: 1.01 },
    { type: 'date', min: '2026-00-01', max: '2026-12-31' },
    { type: 'date', min: '2026-01-01', max: '2026-13-01' },
    { type: 'date', min: '2026-01-00', max: '2026-12-31' },
    { type: 'date', min: '2026-01-01', max: '2026-12-32' },
    { type: 'date', min: '2026-1-01', max: '2026-12-31' },
    { type: 'money', min: '0', max: 1 },
    { type: 'money', min: 0, max: 1, decimals: 3 },
    { type: 'money', min: 0, max: 1, decimals: -1 },
    { type: 'integer', min: 0.5, max: 1 },
    { type: 'integer', min: 0, max: 1.5 },
    { type: 'number', min: 0, max: 1 },
    { type: 'number', min: 0, max: 1, decimals: 7 },
    { type: 'number', min: 0, max: 1, decimals: 0.5 },
    { type: 'choice', options: [] },
    { type: 'choice', options: [null] },
    { type: 'choice', options: ['a'], weights: [-1] },
    { type: 'text', lang: 'fr', minLength: 1, maxLength: 2 },
    { type: 'text', lang: 'zh', minLength: 0, maxLength: 2 },
    { type: 'text', lang: 'en', minLength: 1, maxLength: 2.5 },
    { type: 'array', minItems: -1, maxItems: 2, items: { type: 'name' } },
    { type: 'array', minItems: 0, maxItems: 2.5, items: { type: 'name' } },
    { type: 'constant', value: null },
    { type: 'constant', value: {} },
    { type: 'sum', of: [] },
    { type: 'unknown' },
  ])('rejects malformed generator settings before generation: %j', field => {
    expect(rulesSchema.safeParse(document(field)).success).toBe(false);
  });

  test.each([
    { type: 'checkbox', probability: 0, blankProbability: 1, description: '' },
    { type: 'checkbox', probability: 1, blankProbability: 0 },
    { type: 'constant', value: false },
    { type: 'constant', value: '' },
    { type: 'choice', options: ['活期'] },
    { type: 'date', min: '2026-02-31', max: '2026-02-31' },
    { type: 'money', min: -1.5, max: -1.5, decimals: 0 },
    { type: 'integer', min: -1, max: -1 },
    { type: 'number', min: -0.5, max: -0.5, decimals: 0 },
    { type: 'number', min: 0, max: 1, decimals: 6 },
    { type: 'text', lang: 'zh', minLength: 1, maxLength: 1 },
    { type: 'text', lang: 'en', minLength: 1, maxLength: 1 },
    {
      type: 'array',
      minItems: 0,
      maxItems: 0,
      items: { type: 'constant', value: true },
    },
    { type: 'choice', options: [true, 1, '1'], weights: [0, 0.1, 0] },
  ])(
    'preserves valid boundary settings without imposing engine policy: %j',
    field => {
      const input = document(field);
      expect(rulesSchema.parse(input)).toEqual(input);
    },
  );
});

describe('date-sorted array rules', () => {
  const date: RuleField = {
    type: 'date',
    min: '2026-01-01',
    max: '2026-12-31',
  };
  const items: RuleField = {
    type: 'object',
    fields: {
      date,
      amount: { type: 'money', min: 0, max: 100 },
      label: { type: 'constant', value: 'date' },
      detail: { type: 'object', fields: { date } },
    },
  };

  test('preserves sorting with blank dates and derived balances while leaving legacy rules unchanged', () => {
    const legacy = example('valid') as Rules;
    const transactions = legacy.fields.transactions;
    if (
      transactions?.type !== 'array' ||
      transactions.items.type !== 'object'
    ) {
      throw new Error('Expected bank-statement transaction objects');
    }
    const sorted: RuleField = {
      ...transactions,
      sortBy: 'date',
      items: {
        ...transactions.items,
        fields: {
          ...transactions.items.fields,
          date: { ...date, blankProbability: 0.5 },
        },
      },
    };
    const input: Rules = {
      ...legacy,
      fields: { ...legacy.fields, transactions: sorted },
    };
    expect(rulesSchema.parse(input)).toEqual(input);
    Reflect.deleteProperty(transactions, 'sortBy');
    expect(rulesSchema.parse(legacy)).toEqual(legacy);
  });

  test.each([
    ['missing item key', 'missing', items],
    ['money field', 'amount', items],
    ['constant containing the word date', 'label', items],
    ['object field', 'detail', items],
    ['scalar date items', 'date', date],
    ['array items', 'date', { type: 'array', minItems: 0, maxItems: 2, items }],
    ['numeric sortBy', 1, items],
    ['null sortBy', null, items],
    ['boolean sortBy', true, items],
    ['array sortBy', ['date'], items],
    ['object sortBy', { key: 'date' }, items],
    ['empty key', '', items],
    ['digit-leading key', '1date', items],
    ['hyphenated key', 'posted-date', items],
    ['nested field path', 'detail.date', items],
    ['array field path', 'date[]', items],
    ['non-ASCII key', '日期', items],
    ['whitespace-padded key', ' date ', items],
  ])(
    'rejects %s with one actionable issue at transactions.sortBy',
    (_label, sortBy, items) => {
      const result = rulesSchema.safeParse({
        schemaVersion: 1,
        fields: {
          transactions: {
            type: 'array',
            minItems: 0,
            maxItems: 2,
            items,
            sortBy,
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.map(({ path, message }) => ({ path, message })),
        ).toEqual([
          {
            path: ['fields', 'transactions', 'sortBy'],
            message: 'sortBy must name a date field of the items',
          },
        ]);
      }
    },
  );

  test('preserves independent sort keys on nested arrays including underscore and digit identifiers', () => {
    const input = {
      schemaVersion: 1,
      fields: {
        rows: {
          type: 'array',
          minItems: 0,
          maxItems: 2,
          sortBy: 'date',
          items: {
            type: 'object',
            fields: {
              date,
              sub: {
                type: 'array',
                minItems: 0,
                maxItems: 2,
                sortBy: '_Date2',
                items: { type: 'object', fields: { _Date2: date } },
              },
            },
          },
        },
      },
    };
    expect(rulesSchema.parse(input)).toEqual(input);
  });

  test('reports a nested invalid sortBy at the nested array rather than the root', () => {
    const result = rulesSchema.safeParse({
      schemaVersion: 1,
      fields: {
        rows: {
          type: 'array',
          minItems: 0,
          maxItems: 2,
          items: {
            type: 'object',
            fields: {
              sub: {
                type: 'array',
                minItems: 0,
                maxItems: 2,
                sortBy: 'missing',
                items,
              },
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map(({ path, message }) => ({ path, message })),
      ).toEqual([
        {
          path: ['fields', 'rows', 'items', 'fields', 'sub', 'sortBy'],
          message: 'sortBy must name a date field of the items',
        },
      ]);
    }
  });
});

describe('zod-only relationships', () => {
  test.each([
    [{ type: 'date', min: '2026-12-31', max: '2026-01-01' }, ['min', 'max']],
    [{ type: 'money', min: 2, max: 1 }, ['min', 'max']],
    [{ type: 'integer', min: 2, max: 1 }, ['min', 'max']],
    [{ type: 'number', min: 2, max: 1, decimals: 2 }, ['min', 'max']],
    [
      { type: 'text', lang: 'mixed', minLength: 2, maxLength: 1 },
      ['minLength', 'maxLength'],
    ],
    [
      { type: 'array', minItems: 2, maxItems: 1, items: { type: 'name' } },
      ['minItems', 'maxItems'],
    ],
  ] as const)(
    'rejects reversed ranges with a property-level issue: %j',
    (field, keys) => {
      const result = rulesSchema.safeParse(document(field));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            issue =>
              issue.path.length === 3 &&
              issue.path[0] === 'fields' &&
              issue.path[1] === 'value' &&
              keys.some(key => key === issue.path[2]),
          ),
        ).toBe(true);
      }
    },
  );

  test.each([[], [1], [1, 1, 1], [0, 0]].map(weights => ({ weights })))(
    'rejects mismatched or zero-total choice weights %j at weights',
    ({ weights }) => {
      expectIssue(document({ type: 'choice', options: ['a', 'b'], weights }), [
        'fields',
        'value',
        'weights',
      ]);
    },
  );
});

function references(derived: unknown) {
  return {
    schemaVersion: 1,
    fields: {
      opening: { type: 'constant', value: 100 },
      label: { type: 'constant', value: '100' },
      numeric: { type: 'number', min: 0, max: 1, decimals: 2 },
      count: { type: 'integer', min: 0, max: 1 },
      account: {
        type: 'object',
        fields: { limit: { type: 'money', min: 0, max: 10 } },
      },
      amounts: {
        type: 'array',
        minItems: 0,
        maxItems: 2,
        items: { type: 'money', min: 0, max: 10 },
      },
      rows: {
        type: 'array',
        minItems: 0,
        maxItems: 2,
        items: {
          type: 'object',
          fields: {
            amount: { type: 'money', min: 0, max: 10 },
            balance: {
              type: 'runningBalance',
              opening: 'opening',
              add: ['rows[].amount'],
              subtract: [],
            },
            detail: {
              type: 'object',
              fields: { tax: { type: 'integer', min: 0, max: 10 } },
            },
            groups: {
              type: 'array',
              minItems: 0,
              maxItems: 2,
              items: {
                type: 'object',
                fields: {
                  value: { type: 'number', min: 0, max: 1, decimals: 2 },
                },
              },
            },
            total: derived,
          },
        },
      },
      sum: { type: 'sum', of: ['amounts[]'] },
      ratio: { type: 'percentage', part: 'sum', whole: 'opening', decimals: 6 },
    },
  };
}

describe('root-relative numeric FieldPath resolution', () => {
  test.each([-1, 0.5, 7])(
    'rejects percentage precision %j even when both references resolve',
    decimals => {
      expectIssue(
        references({
          type: 'percentage',
          part: 'sum',
          whole: 'opening',
          decimals,
        }),
        ['fields', 'rows', 'items', 'fields', 'total', 'decimals'],
      );
    },
  );

  test('resolves scalar arrays, nested arrays, objects and derived numeric targets from a nested rule', () => {
    const input = references({
      type: 'sum',
      of: [
        'opening',
        'numeric',
        'count',
        'account.limit',
        'amounts[]',
        'rows[].amount',
        'rows[].detail.tax',
        'rows[].groups[].value',
        'rows[].balance',
        'sum',
        'ratio',
      ],
    });
    expect(rulesSchema.parse(input)).toEqual(input);
    const emptyAdjustments = references({
      type: 'runningBalance',
      opening: 'opening',
      add: [],
      subtract: [],
    });
    expect(rulesSchema.parse(emptyAdjustments)).toEqual(emptyAdjustments);
  });

  test.each([
    '',
    '.opening',
    'opening.',
    'rows[0].amount',
    'rows..amount',
    'rows[].amount[]',
    'rows.amount',
    'account[].limit',
    'opening.value',
    'amounts[].value',
    'missing',
    'account.missing',
    'rows[].missing',
    'amount',
    'label',
    'account',
    'rows[]',
  ])(
    'rejects malformed, unresolved or nonnumeric sum target %j at its nested of index',
    path => {
      expectIssue(references({ type: 'sum', of: [path] }), [
        'fields',
        'rows',
        'items',
        'fields',
        'total',
        'of',
        0,
      ]);
    },
  );

  test.each([
    [
      { type: 'runningBalance', opening: 'missing', add: [], subtract: [] },
      ['opening'],
    ],
    [
      {
        type: 'runningBalance',
        opening: 'opening',
        add: ['label'],
        subtract: [],
      },
      ['add', 0],
    ],
    [
      {
        type: 'runningBalance',
        opening: 'opening',
        add: [],
        subtract: ['rows.amount'],
      },
      ['subtract', 0],
    ],
    [
      { type: 'percentage', part: 'label', whole: 'opening', decimals: 0 },
      ['part'],
    ],
    [
      { type: 'percentage', part: 'opening', whole: 'missing', decimals: 6 },
      ['whole'],
    ],
  ] as const)(
    'validates every derived reference property: %j',
    (field, suffix) => {
      expectIssue(references(field), [
        'fields',
        'rows',
        'items',
        'fields',
        'total',
        ...suffix,
      ]);
    },
  );
});
