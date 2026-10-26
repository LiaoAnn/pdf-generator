import { execFileSync } from 'node:child_process';
import type { RuleField, Rules } from '@pdf-generator/contract';
import { expect, test } from 'vitest';
import { generate } from './index.ts';
import { createRng } from './random.ts';

const oneField = (field: RuleField): Rules => ({
  schemaVersion: 1,
  fields: { value: field },
});
const fixedArray = (size: number, items: RuleField): RuleField => ({
  type: 'array',
  minItems: size,
  maxItems: size,
  items,
});
const constant: RuleField = { type: 'constant', value: 0 };

// A timeout kills even synchronous infinite loops without wedging Vitest.
function guardedError(expression: string) {
  const script = `
    import { generate, InvalidRulesError } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    import { decimal } from ${JSON.stringify(new URL('./values.ts', import.meta.url).href)};
    import { createRng } from ${JSON.stringify(new URL('./random.ts', import.meta.url).href)};
    let result = null;
    try { ${expression}; }
    catch (error) {
      result = { name: error.name, issues: error.issues,
        invalidRules: error instanceof InvalidRulesError,
        rangeError: error instanceof RangeError };
    }
    process.stdout.write(JSON.stringify(result));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  );
}

const hugeBounds = [
  { type: 'money', min: 1e14, max: 1e14, decimals: 2 },
  { type: 'money', min: 1e20, max: 1e20 },
  { type: 'number', min: 1e308, max: 1e308, decimals: 6 },
  { type: 'number', min: -1e300, max: 1e300, decimals: 0 },
] as const;

test.each(hugeBounds)(
  'generate rejects unsafe $type bounds [$min, $max] before looping',
  field => {
    const error = guardedError(
      `generate(${JSON.stringify(oneField(field))}, 'huge-bounds')`,
    );
    expect(error).toMatchObject({ invalidRules: true });
    expect(
      error.issues.some(
        (issue: { path: unknown[] }) =>
          JSON.stringify(issue.path.slice(0, 2)) === '["fields","value"]',
      ),
    ).toBe(true);
  },
  10_000,
);

test.each(hugeBounds)(
  'decimal rejects unsafe bounds [$min, $max] instead of looping',
  field => {
    expect(
      guardedError(
        `decimal(createRng('huge', 'value'), ${field.min}, ${field.max}, ${'decimals' in field ? field.decimals : 0})`,
      ),
    ).toMatchObject({ rangeError: true });
  },
  10_000,
);

test('choice preserves both options when finite weights overflow their sum', () => {
  const rules = oneField({
    type: 'choice',
    options: ['a', 'b'],
    weights: [1e308, 1e308],
  });
  const values = Array.from(
    { length: 100 },
    (_, i) => generate(rules, `overflow-${i}`).value,
  );
  expect(new Set(values)).toEqual(new Set(['a', 'b']));
});

test('choice never selects a zero weight beside a huge positive weight', () => {
  const rules = oneField({
    type: 'choice',
    options: ['a', 'b'],
    weights: [1e308, 0],
  });
  for (let i = 0; i < 100; i++)
    expect(generate(rules, `zero-${i}`).value).toBe('a');
});

test('weighted RNG keeps both items reachable when the total overflows', () => {
  const rng = createRng('overflow', 'choice');
  const values = Array.from({ length: 200 }, () =>
    rng.weighted(['a', 'b'], [Number.MAX_VALUE, Number.MAX_VALUE]),
  );
  expect(new Set(values)).toEqual(new Set(['a', 'b']));
});

test.each([
  [
    'billion nested leaves',
    oneField(fixedArray(1000, fixedArray(1000, fixedArray(1000, constant)))),
  ],
  ['100001 leaves', oneField(fixedArray(100001, constant))],
  [
    '100000 leaves plus their outer array',
    oneField(fixedArray(100000, constant)),
  ],
  [
    '100000 empty arrays plus their outer array',
    oneField(fixedArray(100000, fixedArray(0, constant))),
  ],
  [
    '50000 populated objects plus their outer array',
    oneField(fixedArray(50000, { type: 'object', fields: { a: constant } })),
  ],
  [
    '50000 single-item arrays plus their outer array',
    oneField(fixedArray(50000, fixedArray(1, constant))),
  ],
  ...(
    [
      [
        '1000 × 1000 empty arrays even when the outer array is always blank',
        fixedArray(1000, fixedArray(1000, fixedArray(0, constant))),
      ],
      [
        '100000 objects with two empty arrays each',
        fixedArray(100000, {
          type: 'object',
          fields: { a: fixedArray(0, constant), b: fixedArray(0, constant) },
        }),
      ],
      ['100001 empty arrays', fixedArray(100001, fixedArray(0, constant))],
    ] satisfies [string, RuleField][]
  ).map(([label, field]): [string, Rules] => [
    label,
    // Rejection must use maxItems, before drawing a length or blank value.
    // The broken implementation returns null without allocating huge records.
    oneField({ ...field, minItems: 0, blankProbability: 1 } as RuleField),
  ]),
  [
    '100000 leaves plus one empty sibling array',
    {
      schemaVersion: 1,
      fields: {
        value: { ...fixedArray(100000, constant), blankProbability: 1 },
        empty: fixedArray(0, constant),
      },
    },
  ],
  [
    'object fields summed across the record',
    {
      schemaVersion: 1,
      fields: {
        value: fixedArray(50000, {
          type: 'object',
          fields: { a: constant, b: constant },
        }),
        extra: constant,
      },
    },
  ],
])(
  'budget rejects %s before allocating the record',
  (_label, rules) => {
    const error = guardedError(`generate(${JSON.stringify(rules)}, 'budget')`);
    expect(error).toMatchObject({ invalidRules: true });
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['fields'],
          message: expect.stringContaining('100000'),
        }),
      ]),
    );
  },
  10_000,
);

test('budget allows 99999 leaves plus their array, excluding the root record', () => {
  const record = generate(
    oneField(fixedArray(99999, constant)),
    'leaf-boundary',
  );
  expect(record.value).toHaveLength(99999);
});

test('budget allows 99999 empty arrays plus their outer array', () => {
  const record = generate(
    oneField(fixedArray(99999, fixedArray(0, constant))),
    'empty-boundary',
  );
  expect(record.value).toHaveLength(99999);
  expect(
    Array.isArray(record.value) &&
      record.value.every(value => Array.isArray(value) && value.length === 0),
  ).toBe(true);
});

test('budget allows 99998 leaves plus their array and one empty sibling array', () => {
  const record = generate(
    {
      schemaVersion: 1,
      fields: {
        value: fixedArray(99998, constant),
        empty: fixedArray(0, constant),
      },
    },
    'budget-boundary',
  );
  expect(record.value).toHaveLength(99998);
  expect(record.empty).toEqual([]);
});

test.each(['array', 'object'] as const)(
  'budget charges every populated %s wrapper at the exact boundary',
  kind => {
    const item: RuleField =
      kind === 'array'
        ? fixedArray(1, constant)
        : { type: 'object', fields: { a: constant } };
    // 1 outer array + 49,999 × (1 wrapper + 1 leaf) + 1 sibling = 100,000.
    const record = generate(
      {
        schemaVersion: 1,
        fields: { value: fixedArray(49999, item), sibling: constant },
      },
      'populated-container-boundary',
    );
    expect(record.value).toHaveLength(49999);
    expect(record.sibling).toBe(0);
    expect(
      Array.isArray(record.value) &&
        record.value.every(
          value =>
            JSON.stringify(value) === (kind === 'array' ? '[0]' : '{"a":0}'),
        ),
    ).toBe(true);
    const error = guardedError(
      `generate(${JSON.stringify({
        schemaVersion: 1,
        fields: {
          value: fixedArray(49999, item),
          sibling: constant,
          extra: constant,
        },
      })}, 'populated-container-over-limit')`,
    );
    expect(error).toMatchObject({
      invalidRules: true,
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ['fields'],
          message: expect.stringContaining('100000'),
        }),
      ]),
    });
  },
);

test.each([0, 1])(
  'budget rejects 100000 rows with 30 single-item wrappers using maxItems (blank probability %s)',
  blankProbability => {
    let item: RuleField = constant;
    for (let i = 0; i < 30; i++) item = fixedArray(1, item);
    // Level 32 is legal. Both populated and always-blank arrays must
    // budget the full worst case before drawing their length or blank value.
    const rules = oneField({
      ...fixedArray(100000, item),
      minItems: 0,
      blankProbability,
    } as RuleField);
    const error = guardedError(
      `generate(${JSON.stringify(rules)}, 'wrapper-amplification')`,
    );
    expect(error).toMatchObject({
      invalidRules: true,
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ['fields'],
          message: expect.stringContaining('100000'),
        }),
      ]),
    });
  },
);

test('budget counts all 30 nested wrappers at exactly 100000 values and rejects one more', () => {
  let item: RuleField = constant;
  for (let i = 0; i < 30; i++) item = fixedArray(1, item);
  // 1 + 3,225 × 31 + (1 + 23) = 100,000, without charging the root.
  const fields = {
    rows: fixedArray(3225, item),
    padding: fixedArray(23, constant),
  };
  const record = generate(
    { schemaVersion: 1, fields },
    'nested-value-boundary',
  );
  expect(record.padding).toHaveLength(23);
  expect(record.rows).toHaveLength(3225);
  if (!Array.isArray(record.rows)) throw new Error('Expected array rows');
  for (const row of record.rows) {
    let value: typeof row | undefined = row;
    for (let i = 0; i < 30; i++) {
      expect(Array.isArray(value) && value.length === 1).toBe(true);
      if (!Array.isArray(value)) throw new Error('Expected wrapper');
      value = value[0];
    }
    expect(value).toBe(0);
  }
  const error = guardedError(
    `generate(${JSON.stringify({ schemaVersion: 1, fields: { ...fields, extra: constant } })}, 'nested-value-over-limit')`,
  );
  expect(error).toMatchObject({
    invalidRules: true,
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: ['fields'],
        message: expect.stringContaining('100000'),
      }),
    ]),
  });
});

test.each(['object', 'scalar'] as const)(
  'array %s rows use separate random streams rather than repeating one value',
  kind => {
    const integer: RuleField = { type: 'integer', min: 0, max: 1_000_000 };
    const items: RuleField =
      kind === 'object'
        ? { type: 'object', fields: { value: integer } }
        : integer;
    const rows = generate(oneField(fixedArray(20, items)), 'row-streams').value;
    if (!Array.isArray(rows)) throw new Error('Expected array rows');
    const distinct = new Set(rows.map(row => JSON.stringify(row)));
    expect(distinct.size).toBeGreaterThan(1);
  },
);

test('engine forwards name gender instead of drawing both from the same pool', () => {
  const endings = (gender: 'male' | 'female') => {
    const names = generate(
      oneField(fixedArray(200, { type: 'name', gender })),
      'gender',
    ).value;
    if (!Array.isArray(names)) throw new Error('Expected name array');
    return new Set(names.map(name => String(name).slice(-1)));
  };
  const male = endings('male');
  const female = endings('female');
  expect(female).not.toEqual(male);
  expect([...female].some(character => !male.has(character))).toBe(true);
});
