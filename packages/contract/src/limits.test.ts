import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { expect, test } from 'vitest';
import * as contract from './index.ts';
import {
  jsonSchemas,
  type RuleField,
  type Rules,
  rulesSchema,
} from './index.ts';

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

const keyLocations = [
  { name: 'root', path: ['fields'] },
  { name: 'object', path: ['fields', 'a', 'fields'] },
  {
    name: 'array item object',
    path: ['fields', 'a', 'items', 'fields'],
  },
] as const;

function keyedRules(location: string, key: string) {
  const fields = { [key]: { type: 'constant', value: 0 } };
  if (location === 'root') return { schemaVersion: 1, fields };
  const object = { type: 'object', fields };
  return document(
    location === 'object'
      ? object
      : { type: 'array', minItems: 0, maxItems: 1, items: object },
  );
}

test.each(keyLocations)(
  '$name accepts a 64-character field key',
  ({ name }) => {
    expect(
      rulesSchema.safeParse(keyedRules(name, 'k'.repeat(64))).success,
    ).toBe(true);
  },
);

test.each(keyLocations)(
  '$name rejects a 65-character field key at the key path',
  ({ name, path }) => {
    const key = 'k'.repeat(65);
    const result = rulesSchema.safeParse(keyedRules(name, key));
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_key', path: [...path, key] }),
      );
  },
);

function exportedRuleSchemas() {
  return {
    generated: jsonSchemas().rules,
    committed: JSON.parse(
      readFileSync(
        new URL('../schemas/rules.schema.json', import.meta.url),
        'utf8',
      ),
    ) as object,
  };
}

test.each(keyLocations)(
  'Ajv 2020 enforces the 64-character field key boundary in $name',
  ({ name }) => {
    for (const [source, schema] of Object.entries(exportedRuleSchemas())) {
      const validate = new Ajv2020({ strict: true }).compile(schema as object);
      for (const [length, accepted] of [
        [64, true],
        [65, false],
      ] as const) {
        expect
          .soft(
            validate(keyedRules(name, 'k'.repeat(length))),
            `${source}: ${length}-character key; ${JSON.stringify(validate.errors)}`,
          )
          .toBe(accepted);
      }
    }
  },
);

function propertyNamePatterns(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  const { propertyNames } = node as { propertyNames?: { pattern?: unknown } };
  return [
    ...(typeof propertyNames?.pattern === 'string'
      ? [propertyNames.pattern]
      : []),
    ...Object.values(node).flatMap(propertyNamePatterns),
  ];
}

test('Python re.search enforces the 64-character field key boundary in exported propertyNames patterns', () => {
  for (const [source, schema] of Object.entries(exportedRuleSchemas())) {
    const patterns = propertyNamePatterns(schema);
    // Both root fields and the recursive object's fields publish key rules.
    expect(patterns.length, source).toBeGreaterThanOrEqual(2);
    for (const pattern of new Set(patterns)) {
      const matches = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            'import json,re,sys\np=json.load(sys.stdin)\nprint(json.dumps([bool(re.search(p,"k"*n)) for n in [64,65]]))',
          ],
          { input: JSON.stringify(pattern), encoding: 'utf8' },
        ),
      );
      expect.soft(matches, `${source}: ${pattern}`).toEqual([true, false]);
    }
  }
});

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
      header: { type: 'object', fields: { title: { type: 'name' } } },
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
          24999,
        ),
        maxItems,
      ),
    },
  });
  expect(rulesSchema.safeParse(input(1)).success).toBe(true);
  expectIssue(
    input(2),
    ['fields'],
    'a record would hold up to 199997 values; the limit is 100000',
  );
});

test('leaf arrays accept 99999 leaves and reject 100000 because the array itself counts', () => {
  const leaf: RuleField = { type: 'constant', value: 0 };
  expect(rulesSchema.safeParse(document(array(leaf, 99_999))).success).toBe(
    true,
  );
  expectIssue(
    document(array(leaf, 100_000)),
    ['fields'],
    'a record would hold up to 100001 values; the limit is 100000',
  );
});

test('hand-calculated engine value counts agree at the contract boundary for containers and a real pack', () => {
  const leaf: RuleField = { type: 'constant', value: 0 };
  const pack = JSON.parse(
    readFileSync(
      new URL(
        '../../../templates/minimal-example/pack/data/rules.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Rules;
  // fake-data depends on contract; importing it here would create a cycle.
  // Count by hand using engine worstCase(record, () => 1, 1) - 1:
  // nested arrays: 1 + 2 × (1 + 3) = 9;
  // objects in an array: 1 + 3 × (1 + 2) = 10;
  // empty arrays: 1, even with a large unreachable item subtree;
  // minimal pack: 7 scalars + (1 + 6 × 4) attendees + (1 + 4) items = 37.
  const cases: [string, Rules['fields'], number][] = [
    ['nested arrays', { a: array(array(leaf, 3), 2) }, 9],
    [
      'objects in arrays',
      { a: array({ type: 'object', fields: { x: leaf, y: leaf } }, 3) },
      10,
    ],
    ['empty array', { a: array(leaf, 0) }, 1],
    [
      'empty array above nested arrays',
      { a: array(array(leaf, 1_000_000), 0) },
      1,
    ],
    ['minimal-example pack', pack.fields, 37],
  ];
  for (const [label, fields, count] of cases) {
    // Padding contributes one array plus its leaves; root is excluded.
    const input = (extra: number): Rules => ({
      schemaVersion: 1,
      fields: { ...fields, padding: array(leaf, 100_000 - count - 1 + extra) },
    });
    expect(rulesSchema.safeParse(input(0)).success, label).toBe(true);
    expectIssue(
      input(1),
      ['fields'],
      'a record would hold up to 100001 values; the limit is 100000',
    );
  }
});

test('object keys multiply through 100000 rows even when every leaf is numeric', () => {
  expectIssue(
    {
      schemaVersion: 1,
      fields: {
        rows: array(
          {
            type: 'object',
            fields: { ['k'.repeat(64)]: { type: 'constant', value: 0 } },
          },
          100_000,
        ),
      },
    },
    ['fields'],
    'a record would hold up to 6400004 characters of text; the limit is 1000000',
  );
});

test('zero-item arrays do not count item object keys or string contents', () => {
  expect(
    rulesSchema.safeParse(
      document(
        array(
          {
            type: 'object',
            fields: {
              ['k'.repeat(64)]: {
                type: 'constant',
                value: 'x'.repeat(1_000_001),
              },
            },
          },
          0,
        ),
      ),
    ).success,
  ).toBe(true);
});

// Root keys add 8 characters, padding adds 992: 1,000 outside the arrays.
function paddedDocument(field: RuleField) {
  return {
    schemaVersion: 1,
    fields: { a: field, padding: { type: 'constant', value: 'x'.repeat(992) } },
  };
}

test('nested arrays enforce text characters and keys inclusively without counting numeric leaves', () => {
  const input = (maxLength: number) =>
    paddedDocument(
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
              literal: { type: 'constant', value: 123 },
            },
          },
          100,
        ),
        10,
      ),
    );
  // 1,000 objects × (581 + 400 text + 18 key characters) + 1,000.
  expect(rulesSchema.safeParse(input(581)).success).toBe(true);
  expectIssue(
    input(582),
    ['fields'],
    'a record would hold up to 1001000 characters of text; the limit is 1000000',
  );
});

test.each([
  ['string constant', { type: 'constant', value: 'x'.repeat(60_000) }],
  [
    'longest string choice option',
    { type: 'choice', options: ['short', 123, false, 'x'.repeat(60_000)] },
  ],
] satisfies [string, RuleField][])(
  'rejects 6000000001 characters including the root key from an array of %s leaves',
  (_label, items) => {
    expectIssue(
      document(array(items, 100_000)),
      ['fields'],
      'a record would hold up to 6000000001 characters of text; the limit is 1000000',
    );
  },
);

test.each([
  ['string constant', { type: 'constant', value: 'x'.repeat(9_999) }],
  [
    'longest string choice option',
    {
      type: 'choice',
      options: ['x'.repeat(9_999), 'y'.repeat(9_998), 123, true],
    },
  ],
] satisfies [string, RuleField][])(
  'accepts exactly 1000000 characters including keys from an array of %s leaves',
  (_label, items) => {
    // 100 × 9,999 + root keys (1 + 7) + padding (92) = 1,000,000.
    const input = (padding: number) => ({
      schemaVersion: 1,
      fields: {
        a: array(items, 100),
        padding: { type: 'constant', value: 'x'.repeat(padding) },
      },
    });
    expect(rulesSchema.safeParse(input(92)).success).toBe(true);
    expectIssue(
      input(93),
      ['fields'],
      'a record would hold up to 1000001 characters of text; the limit is 1000000',
    );
  },
);

test('adds text maxLength, string constants, longest string choice and keys across nested arrays inclusively', () => {
  const input = (maxLength: number) =>
    paddedDocument(
      array(
        array(
          {
            type: 'object',
            fields: {
              prose: { type: 'text', lang: 'en', minLength: 1, maxLength },
              literal: { type: 'constant', value: 'x'.repeat(300) },
              choice: {
                type: 'choice',
                options: ['y'.repeat(500), 'z'.repeat(499), 123, false],
              },
            },
          },
          100,
        ),
        10,
      ),
    );
  // 1,000 objects × (181 + 300 + 500 text + 18 key characters) + 1,000.
  expect(rulesSchema.safeParse(input(181)).success).toBe(true);
  expectIssue(
    input(182),
    ['fields'],
    'a record would hold up to 1001000 characters of text; the limit is 1000000',
  );
});

test('number and boolean choice options contribute zero text characters', () => {
  expect(
    rulesSchema.safeParse(
      document(
        array({ type: 'choice', options: [1234567890, true, false] }, 99_999),
      ),
    ).success,
  ).toBe(true);
});

test('string constants use JS string length rather than Unicode code point count', () => {
  expectIssue(
    document(array({ type: 'constant', value: '😀'.repeat(5_001) }, 100)),
    ['fields'],
    'a record would hold up to 1000201 characters of text; the limit is 1000000',
  );
});

test.each([
  ['text', { type: 'text', lang: 'en', minLength: 1, maxLength: 1_000_001 }],
  ['string constant', { type: 'constant', value: 'x'.repeat(1_000_001) }],
  ['string choice', { type: 'choice', options: ['x'.repeat(1_000_001)] }],
] satisfies [string, RuleField][])(
  'zero-item arrays contribute one value and zero characters for %s leaves',
  (_label, items) => {
    const input = (maxItems: number) => ({
      schemaVersion: 1,
      fields: {
        header: { type: 'name' },
        rows: array(array(items, 0), maxItems),
      },
    });
    expect(rulesSchema.safeParse(input(99_998)).success).toBe(true);
    expectIssue(
      input(99_999),
      ['fields'],
      'a record would hold up to 100001 values; the limit is 100000',
    );
  },
);

test('sibling empty arrays in object items multiply into the record value budget inclusively', () => {
  const items: RuleField = {
    type: 'object',
    fields: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `e${i}`,
        array({ type: 'name' }, 0),
      ]),
    ),
  };
  // 1 outer array + 497 × (1 object + 200 empty arrays) + 102 leaves.
  const boundary = {
    schemaVersion: 1,
    fields: {
      a: array(items, 497),
      ...Object.fromEntries(
        Array.from({ length: 102 }, (_, i) => [
          `n${i}`,
          { type: 'constant', value: 0 },
        ]),
      ),
    },
  };
  expect(rulesSchema.safeParse(boundary).success).toBe(true);
  expectIssue(
    {
      ...boundary,
      fields: { ...boundary.fields, extra: { type: 'constant', value: 0 } },
    },
    ['fields'],
    'a record would hold up to 100001 values; the limit is 100000',
  );
  expectIssue(
    document(array(items, 100_000)),
    ['fields'],
    'a record would hold up to 20100001 values; the limit is 100000',
  );
});

test.each([
  ['empty arrays', array({ type: 'name' }, 0), 99_999, 100_001],
  [
    'objects containing only an empty array',
    { type: 'object', fields: { empty: array({ type: 'name' }, 0) } },
    49_999,
    200_001,
  ],
] satisfies [string, RuleField, number, number][])(
  'counts every container in %s including the outer array',
  (_label, items, acceptedItems, rejectedCount) => {
    expect(
      rulesSchema.safeParse(document(array(items, acceptedItems))).success,
    ).toBe(true);
    expectIssue(
      document(array(items, 100_000)),
      ['fields'],
      `a record would hold up to ${rejectedCount} values; the limit is 100000`,
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
  expect.soft(description).toMatch(/1000000 characters of text/);
  expect.soft(description).toMatch(/text maxLength/);
  expect.soft(description).toMatch(/string constants/);
  expect.soft(description).toMatch(/longest string choice option/);
  expect.soft(description).toMatch(/\bkeys\b/i);
});
