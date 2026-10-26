import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as contract from './index.ts';
import { jsonSchemas, type RuleField, rulesSchema } from './index.ts';

function document(field: unknown) {
  return { schemaVersion: 1, fields: { a: field } };
}
function array(items: RuleField, maxItems: number): RuleField {
  return { type: 'array', minItems: 0, maxItems, items };
}
function nested(levels: number, kind: 'array' | 'object' | 'mixed') {
  let field: RuleField = { type: 'name' };
  let path: (string | number)[] = ['fields', 'a'];
  for (let i = 1; i < levels; i++) {
    const object = kind === 'object' || (kind === 'mixed' && i % 2 === 0);
    field = object ? { type: 'object', fields: { b: field } } : array(field, 1);
    path = [
      'fields',
      'a',
      ...(object ? ['fields', 'b'] : ['items']),
      ...path.slice(2),
    ];
  }
  return { field, path };
}
function expectIssue(
  input: unknown,
  path: (string | number)[],
  message: string,
) {
  const result = rulesSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path, message }),
    );
}

test('publishes rule budgets so callers can explain rejected uploads', () => {
  expect(contract).toHaveProperty('ruleLimits', {
    maxLevels: 32,
    maxValues: 100_000,
    maxTextCharacters: 1_000_000,
  });
});

test.each(['array', 'object', 'mixed'] as const)(
  '%s fields accept level 32 and locate the first field at level 33',
  kind => {
    expect(
      rulesSchema.safeParse(document(nested(32, kind).field)).success,
    ).toBe(true);
    const { field, path } = nested(33, kind);
    expectIssue(
      document(field),
      path,
      'fields nest 33 levels deep; the limit is 32',
    );
  },
);

test.each(['array', 'object'] as const)(
  '5000 nested %s rules return failure instead of throwing RangeError',
  kind => {
    const input = document(nested(5000, kind).field);
    expect(rulesSchema.safeParse(input).success).toBe(false);
  },
);

test.each(['extra', 'description', 'value'])(
  '5000-deep JSON under %s returns failure without overflowing',
  key => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 5000; i++) value = { child: value };
    const input =
      key === 'extra'
        ? { ...document({ type: 'name' }), extra: value }
        : document({ type: 'constant', value: 1, [key]: value });
    expect(rulesSchema.safeParse(input).success).toBe(false);
  },
);

test('nested array multiplication and sibling addition enforce the record value budget inclusively', () => {
  const input = (maxItems: number) => ({
    schemaVersion: 1,
    fields: {
      header: { type: 'name' },
      rows: array(
        array(
          {
            type: 'object',
            fields: {
              amount: { type: 'constant', value: 1 },
              flag: { type: 'checkbox' },
              label: { type: 'company' },
            },
          },
          33333,
        ),
        maxItems,
      ),
    },
  });
  expect(rulesSchema.safeParse(input(1)).success).toBe(true);
  expectIssue(
    input(2),
    ['fields'],
    'a record would hold up to 199999 values; the limit is 100000',
  );
});

test('nested arrays enforce filler characters inclusively without counting non-text leaves', () => {
  const input = (maxLength: number) =>
    document(
      array(
        array(
          {
            type: 'object',
            fields: {
              prose: { type: 'text', lang: 'zh', minLength: 1, maxLength },
              second: {
                type: 'text',
                lang: 'en',
                minLength: 1,
                maxLength: 400,
              },
              literal: { type: 'constant', value: 'not filler' },
            },
          },
          100,
        ),
        10,
      ),
    );
  expect(rulesSchema.safeParse(input(600)).success).toBe(true);
  expectIssue(
    input(601),
    ['fields'],
    'a record would hold up to 1001000 characters of filler text; the limit is 1000000',
  );
});

test('zero-item arrays contribute neither values nor filler characters', () => {
  const input = document(
    array(
      array(
        { type: 'text', lang: 'en', minLength: 1, maxLength: 1_000_001 },
        100_001,
      ),
      0,
    ),
  );
  expect(rulesSchema.safeParse(input).success).toBe(true);
});

test.each([
  ['empty arrays', array({ type: 'name' }, 0)],
  [
    'objects containing only an empty array',
    { type: 'object', fields: { empty: array({ type: 'name' }, 0) } },
  ],
] satisfies [string, RuleField][])(
  'counts %s as at least one value per outer array item',
  (_label, items) => {
    expect(rulesSchema.safeParse(document(array(items, 100_000))).success).toBe(
      true,
    );
    expectIssue(
      document(array(items, 100_000_000)),
      ['fields'],
      'a record would hold up to 100000000 values; the limit is 100000',
    );
  },
);

test.each(['root', 'object', 'zero-item array object'] as const)(
  '150000 sibling fields in a %s return a result without argument-spread overflow',
  location => {
    const fields: Record<string, RuleField> = Object.fromEntries(
      Array.from({ length: 150_000 }, (_, i) => [`f${i}`, { type: 'name' }]),
    );
    const input =
      location === 'root'
        ? { schemaVersion: 1, fields }
        : document(
            location === 'object'
              ? { type: 'object', fields }
              : array({ type: 'object', fields }, 0),
          );
    let result: ReturnType<typeof rulesSchema.safeParse> | undefined;
    expect(() => {
      result = rulesSchema.safeParse(input);
    }).not.toThrow();
    expect(result).toHaveProperty(
      'success',
      location === 'zero-item array object',
    );
  },
);

test('all six shipped packs remain usable under the budgets', () => {
  const root = new URL('../../../templates/', import.meta.url);
  const files = readdirSync(root).map(
    name => new URL(`${name}/pack/data/rules.json`, root),
  );
  expect(files).toHaveLength(6);
  for (const file of files)
    expect(
      rulesSchema.safeParse(JSON.parse(readFileSync(file, 'utf8'))).success,
      file.pathname,
    ).toBe(true);
});

test('Python consumers can discover runtime budgets in the rules schema description', () => {
  const description = String(jsonSchemas().rules?.description).replaceAll(
    ',',
    '',
  );
  for (const limit of [/\b32\b/, /\b100000\b/, /\b1000000\b/])
    expect.soft(description).toMatch(limit);
});
