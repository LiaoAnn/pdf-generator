import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

// Kill synchronous CPU exhaustion without wedging the Vitest worker. Keep
// assertions in the child so large records never need to cross stdout.
function guardedGeneration(body: string, timeout = 10_000) {
  const script = `
    import assert from 'node:assert/strict';
    import { rulesSchema } from '@pdf-generator/contract';
    import { generate, InvalidRulesError } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const constant = value => ({ type: 'constant', value });
    const text = (minLength, maxLength = minLength) =>
      ({ type: 'text', lang: 'zh', minLength, maxLength });
    const array = (count, items) =>
      ({ type: 'array', minItems: count, maxItems: count, items });
    const object = fields => ({ type: 'object', fields });
    const rulesFor = fields => rulesSchema.parse({ schemaVersion: 1, fields });
    ${body}
    process.stdout.write('ok');
  `;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      cwd: new URL('../', import.meta.url),
      timeout,
    }),
  ).toBe('ok');
}

function guardedDerivedBudget(body: string, timeout = 10_000) {
  guardedGeneration(
    `
    const budgetFields = (rowCount = 50, balanceCount = 20, columnCount = 1_000) => {
      const paths = Array.from({ length: columnCount }, (_, i) => 'rows[].c.v' + i);
      return {
        opening: constant(0),
        rows: array(rowCount, object({
          c: object(Object.fromEntries(paths.map((_, i) => ['v' + i, constant(1)]))),
          ...Object.fromEntries(Array.from({ length: balanceCount }, (_, i) => [
            'b' + i,
            { type: 'runningBalance', opening: 'opening', add: paths, subtract: [] },
          ])),
        })),
      };
    };
    const assertBudgetRejected = fields => {
      const rules = rulesFor(fields);
      assert.throws(() => generate(rules, 'derived-budget'), error => {
        assert.ok(error instanceof InvalidRulesError, 'expected InvalidRulesError');
        assert.ok(error.issues.some(issue =>
          JSON.stringify(issue.path) === '["fields"]'), 'expected a record-level fields issue');
        return true;
      }, 'expected derived-evaluation budget rejection before generation');
    };
    ${body}
  `,
    timeout,
  );
}

test('nesting limit accepts level 32 and generates 20000 deeply nested running balances', () => {
  guardedGeneration(`
    let nest = array(20_000, {
      type: 'runningBalance', opening: 'opening', add: [], subtract: [],
    });
    // Root array is level 1; 30 wrappers put each balance at level 32.
    for (let i = 0; i < 30; i++) nest = array(1, nest);
    const record = generate(rulesFor({ opening: constant(1), nest }), 'depth-boundary');
    assert.equal(record.opening, 1);
    let balances = record.nest;
    for (let i = 0; i < 30; i++) {
      assert.equal(balances.length, 1);
      balances = balances[0];
    }
    assert.equal(balances.length, 20_000);
    for (const balance of balances) assert.equal(balance, 1);
  `);
}, 15_000);

test('nesting limit accepts object fields at level 32', () => {
  guardedGeneration(`
    let nest = constant(7);
    for (let i = 0; i < 31; i++) nest = object({ child: nest });
    const record = generate(rulesFor({ nest }), 'object-depth-boundary');
    let value = record.nest;
    for (let i = 0; i < 31; i++) value = value.child;
    assert.equal(value, 7);
  `);
}, 15_000);

test.each(['array', 'object'])(
  'nesting limit promptly rejects %s fields at level 33 with the offending rule path',
  kind => {
    guardedGeneration(
      `
      let nest = constant(7);
      const firstTooDeep = ['fields', 'nest'];
      for (let i = 0; i < 32; i++) {
        nest = ${kind === 'array' ? 'array(1, nest)' : 'object({ child: nest })'};
        firstTooDeep.push(...${kind === 'array' ? "['items']" : "['fields', 'child']"});
      }
      const rules = rulesFor({ nest });
      assert.throws(() => generate(rules, 'depth-over-limit'), error => {
        assert.ok(error instanceof InvalidRulesError, 'expected InvalidRulesError');
        assert.equal(error.issues.length, 1, 'expected one issue for the too-deep branch');
        assert.deepEqual(error.issues[0].path.slice(0, firstTooDeep.length), firstTooDeep,
          'expected an issue identifying the first field at level 33');
        return true;
      }, 'expected level 33 to be rejected');
    `,
      3_000,
    );
  },
  15_000,
);

test('nesting limit promptly rejects 100 array wrappers around 20000 balances with one branch issue', () => {
  guardedGeneration(
    `
    let nest = array(20_000, {
      type: 'runningBalance', opening: 'opening', add: [], subtract: [],
    });
    for (let i = 0; i < 100; i++) nest = array(1, nest);
    const rules = rulesFor({ opening: constant(1), nest });
    const firstTooDeep = ['fields', 'nest', ...Array(32).fill('items')];
    assert.throws(() => generate(rules, 'reviewer-depth-exhaustion'), error => {
      assert.ok(error instanceof InvalidRulesError, 'expected InvalidRulesError');
      assert.equal(error.issues.length, 1, 'expected one issue, not one per deeper level');
      assert.deepEqual(error.issues[0].path.slice(0, firstTooDeep.length), firstTooDeep,
        'expected an issue identifying the first field at level 33');
      return true;
    }, 'expected 100 array wrappers to be rejected before generation');
  `,
    3_000,
  );
}, 15_000);

test.each([
  [200, 200, 200],
  [160, 300, 300],
])(
  'derived budget promptly rejects %i rows × %i balances × %i distinct paths',
  (rows, balances, paths) => {
    guardedDerivedBudget(
      `
      assertBudgetRejected(budgetFields(${rows}, ${balances}, ${paths}));
    `,
      3_000,
    );
  },
  15_000,
);

test('derived budget rejects one step above the limit contributed by a sum', () => {
  guardedDerivedBudget(
    `
    // 50 × 20 × 1,000 balance steps + one distinct sum path = 1,000,001.
    assertBudgetRejected({
      ...budgetFields(),
      extra: { type: 'sum', of: ['opening'] },
    });
  `,
    3_000,
  );
}, 15_000);

test('derived budget multiplies all enclosing maxItems even for empty always-blank arrays', () => {
  guardedDerivedBudget(
    `
    const fields = budgetFields(25);
    const row = fields.rows.items;
    for (let i = 0; i < 20; i++) {
      row.fields['b' + i].add = Array.from({ length: 1_000 }, (_, j) =>
        'groups[].rows[].c.v' + j);
    }
    // 2 × 25 × 20 × 1,000 + 1, although this seed produces no groups.
    assertBudgetRejected({
      opening: fields.opening,
      groups: {
        ...array(2, object({ rows: { ...fields.rows, minItems: 0, blankProbability: 1 } })),
        minItems: 0, blankProbability: 1,
      },
      extra: { type: 'sum', of: ['opening'] },
    });
  `,
    3_000,
  );
}, 15_000);

test('derived budget accepts exactly one million balance steps and deduplicates across add and subtract', () => {
  guardedDerivedBudget(`
    const fields = budgetFields();
    for (let i = 0; i < 20; i++) fields.rows.items.fields['b' + i].subtract = ['rows[].c.v0'];
    // 50 × 20 × 1,000 distinct paths = 1,000,000 steps; fewer than 53,000 values.
    const record = generate(rulesFor(fields), 'balance-budget-boundary');
    assert.equal(record.rows.length, 50);
    for (const i of [0, 24, 49]) {
      for (const b of ['b0', 'b10', 'b19']) assert.equal(record.rows[i][b], 999 * (i + 1));
    }
  `);
}, 15_000);

// rows[] holds `lines` (a chain of nested arrays, one count per level) and
// `balances` running balances that each add the given leaf names below it.
const fanOutBudgetSetup = `
  const fanOutFields = (rowCount, lineCounts, balanceCount, leaves = ['amount']) => {
    const leafObject = object(Object.fromEntries(leaves.map(leaf => [leaf, constant(1)])));
    let lines = leafObject;
    for (let i = lineCounts.length - 1; i >= 0; i--) {
      lines = array(lineCounts[i], i === lineCounts.length - 1
        ? lines : object({ items: lines }));
    }
    const infix = lineCounts.map((_, i) => (i === 0 ? 'lines[]' : 'items[]')).join('.');
    const paths = leaves.map(leaf => 'rows[].' + infix + '.' + leaf);
    return {
      opening: constant(0),
      rows: array(rowCount, object({
        lines,
        ...Object.fromEntries(Array.from({ length: balanceCount }, (_, i) => [
          'b' + i,
          { type: 'runningBalance', opening: 'opening', add: paths, subtract: [] },
        ])),
      })),
    };
  };
`;

test('derived budget charges a balance for every line it re-sums: 1 row × 500 balances × 50,000 lines is rejected promptly', () => {
  guardedDerivedBudget(
    `
    ${fanOutBudgetSetup}
    // 1 × 500 × 50,000 = 25,000,000 steps; only ~50,500 values.
    assertBudgetRejected(fanOutFields(1, [50_000], 500));
  `,
    3_000,
  );
}, 15_000);

test('derived budget accepts exactly one million steps from 1,000 balances over 1,000 lines', () => {
  guardedDerivedBudget(`
    ${fanOutBudgetSetup}
    const start = performance.now();
    const record = generate(rulesFor(fanOutFields(1, [1_000], 1_000)), 'fan-out-boundary');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3_000, 'fan-out boundary took ' + elapsed.toFixed(1) + ' ms');
    assert.equal(record.rows.length, 1);
    for (let b = 0; b < 1_000; b++) assert.equal(record.rows[0]['b' + b], 1_000, 'balance ' + b);
  `);
}, 15_000);

test('derived budget rejects one step above the limit when a sum adds to a fan-out boundary', () => {
  guardedDerivedBudget(
    `
    ${fanOutBudgetSetup}
    assertBudgetRejected({
      ...fanOutFields(1, [1_000], 1_000),
      extra: { type: 'sum', of: ['opening'] },
    });
  `,
    3_000,
  );
}, 15_000);

test.each([
  ['accepts exactly one million steps', 100, false],
  ['rejects 1,010,000 steps', 101, true],
])(
  'derived budget multiplies fan-out through nested arrays: 100 × 100 lines, %s',
  (_regression, balances, rejected) => {
    guardedDerivedBudget(
      `
      ${fanOutBudgetSetup}
      const fields = fanOutFields(1, [100, 100], ${balances});
      if (${rejected}) {
        assertBudgetRejected(fields);
      } else {
        const record = generate(rulesFor(fields), 'nested-fan-out-boundary');
        assert.equal(record.rows.length, 1);
        for (const b of [0, 50, 99]) assert.equal(record.rows[0]['b' + b], 10_000);
      }
    `,
      rejected ? 3_000 : 10_000,
    );
  },
  15_000,
);

test.each([
  ['accepts exactly one million steps', false],
  ['rejects one step above the limit', true],
])(
  'derived budget multiplies instances, balances and the fan-out of every distinct path: 10 rows × 1,000 balances × 2 × 50 lines %s',
  (_regression, rejected) => {
    guardedDerivedBudget(
      `
      ${fanOutBudgetSetup}
      const fields = fanOutFields(10, [50], 1_000, ['amount', 'fee']);
      if (${rejected}) {
        assertBudgetRejected({ ...fields, extra: { type: 'sum', of: ['opening'] } });
      } else {
        const record = generate(rulesFor(fields), 'instances-fan-out-boundary');
        assert.equal(record.rows.length, 10);
        for (const i of [0, 4, 9]) {
          for (const b of [0, 500, 999]) assert.equal(record.rows[i]['b' + b], 100 * (i + 1));
        }
      }
    `,
      rejected ? 3_000 : 10_000,
    );
  },
  15_000,
);

// rows[] holds `aCount` objects `a`, each with an array `b` of `bCount`
// objects, and `balances` running balances over rows[].a[].b[].v.
const belowEmptyBudgetSetup = `
  const belowEmptyFields = (rowCount, aCount, bCount, balanceCount) => ({
    opening: constant(0),
    rows: array(rowCount, object({
      a: array(aCount, object({
        b: array(bCount, object({ v: { type: 'integer', min: 0, max: 9 } })),
      })),
      ...Object.fromEntries(Array.from({ length: balanceCount }, (_, i) => [
        'bal' + i,
        {
          type: 'runningBalance', opening: 'opening',
          add: ['rows[].a[].b[].v'], subtract: [],
        },
      ])),
    })),
  });
`;

test('derived budget keeps the fan-out of arrays above an empty array: 316 rows × 316 balances × 1,000 empty-below lines is rejected promptly', () => {
  guardedDerivedBudget(
    `
    ${belowEmptyBudgetSetup}
    // 316 × 316 × 1,000 ≈ 99.9M steps: every a is still walked, although each b is empty.
    assertBudgetRejected(belowEmptyFields(316, 1_000, 0, 316));
  `,
    3_000,
  );
}, 15_000);

test('derived budget accepts exactly one million steps when 1,000 balances walk 1,000 lines with empty arrays below', () => {
  guardedDerivedBudget(`
    ${belowEmptyBudgetSetup}
    const start = performance.now();
    const record = generate(rulesFor(belowEmptyFields(1, 1_000, 0, 1_000)), 'below-empty-boundary');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3_000, 'below-empty boundary took ' + elapsed.toFixed(1) + ' ms');
    assert.equal(record.rows.length, 1);
    for (let b = 0; b < 1_000; b++) assert.equal(record.rows[0]['bal' + b], 0, 'balance ' + b);
  `);
}, 15_000);

test('derived budget rejects one step above the limit when a sum adds to an empty-below boundary', () => {
  guardedDerivedBudget(
    `
    ${belowEmptyBudgetSetup}
    assertBudgetRejected({
      ...belowEmptyFields(1, 1_000, 0, 1_000),
      extra: { type: 'sum', of: ['opening'] },
    });
  `,
    3_000,
  );
}, 15_000);

test('derived budget charges one step per path when an empty array sits above a 1,000-item array: 1,000 rows × 90 balances', () => {
  guardedDerivedBudget(`
    ${belowEmptyBudgetSetup}
    // Fan-out [0, 1,000] is 0, so each path costs 1: 1,000 × 90 = 90,000 steps,
    // within the 100,000 value cap (the 90,000 balances are the only values).
    const start = performance.now();
    const record = generate(rulesFor(belowEmptyFields(1_000, 0, 1_000, 90)), 'empty-above-boundary');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3_000, 'empty-above run took ' + elapsed.toFixed(1) + ' ms');
    assert.equal(record.rows.length, 1_000);
    for (const i of [0, 499, 999]) {
      assert.deepEqual(record.rows[i].a, []);
      for (let b = 0; b < 90; b++) assert.equal(record.rows[i]['bal' + b], 0, 'row ' + i + ' balance ' + b);
    }
  `);
}, 15_000);

test.each([
  [
    'accepts exactly one million steps with repeated sum paths and identical percentage paths',
    'v0',
    false,
  ],
  [
    'rejects one step above the limit when percentage paths are distinct',
    'v1',
    true,
  ],
])(
  'derived budget %s',
  (_regression, whole, rejected) => {
    guardedDerivedBudget(
      `
      const fields = budgetFields(50, 19, 999);
      const row = fields.rows.items.fields;
      const paths = Array.from({ length: 999 }, (_, i) => 'rows[].c.v' + i);
      row.total = { type: 'sum', of: [...paths, ...paths] };
      fields.globalTotal = { type: 'sum', of: paths };
      row.ratio = { type: 'percentage', part: 'rows[].c.v0', whole: 'rows[].c.${whole}', decimals: 0 };
      // Balances: 50 × 19 × 999 = 949,050; row sum: 50 × 999 = 49,950
      // despite repeated paths; global sum: 999; percentage: 1 or 2.
      // Total: exactly 1,000,000 or 1,000,001. Under 53,000 values.
      if (${rejected}) {
        assertBudgetRejected(fields);
      } else {
        const record = generate(rulesFor(fields), 'mixed-budget-boundary');
        assert.equal(record.rows.length, 50);
        assert.equal(record.globalTotal, 49_950);
        for (const i of [0, 24, 49]) {
          assert.equal(record.rows[i].b18, 999 * (i + 1));
          assert.equal(record.rows[i].total, 1_998);
          assert.equal(record.rows[i].ratio, 100);
        }
      }
    `,
      rejected ? 3_000 : 10_000,
    );
  },
  15_000,
);

test.each([false, true])(
  'row-scoped sum budget uses nested instances and widest unbound fan-out (one above: %s)',
  rejected => {
    guardedDerivedBudget(`
      const paths = [
        'groups[].rows[].sub[].empty[].v',
        'groups[].extra[].v',
        'groups[].k',
        'other[]',
      ];
      const fields = {
        other: array(100, constant(1)),
        groups: array(2, object({
          k: constant(1),
          extra: array(20, object({ v: constant(1) })),
          rows: array(5, object({
            sub: array(10, object({ empty: array(0, object({ v: constant(1) })) })),
            ...Object.fromEntries(Array.from({ length: 3_125 }, (_, i) => [
              's' + i, { type: 'sum', of: [...paths, ...paths] },
            ])),
          })),
        })),
      };
      // 2 × 5 instances × (10 + 20 + 1 + 1) × 3,125 = 1,000,000.
      // The empty array does not erase the fan-out above it. For other[]
      // k=0, so it costs one lookup per instance, not its 100 items.
      // Repeated paths count once for the budget but twice for the value.
      if (${rejected}) {
        assertBudgetRejected({ ...fields, extra: { type: 'sum', of: ['other[]'] } });
      } else {
        const record = generate(rulesFor(fields), 'row-sum-budget-boundary');
        for (const group of record.groups) {
          for (const row of group.rows) {
            for (const i of [0, 1_562, 3_124]) assert.equal(row['s' + i], 242);
          }
        }
      }
    `);
  },
  15_000,
);

test.each([
  [
    'rejects a billion-character scalar before generating filler',
    '{ value: text(1e9) }',
  ],
  [
    'rejects text totals above the limit even when every field fits individually',
    `{
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['text' + i, text(100_000)])),
      extra: text(1),
    }`,
  ],
  [
    'charges maxLength even for short or always-blank text',
    '{ value: { ...text(1, 1_000_001), blankProbability: 1 } }',
  ],
  [
    'multiplies every enclosing maxItems even for empty or always-blank arrays',
    `{
      groups: {
        ...array(101, object({ rows: array(10, object({ value: text(1_000) })) })),
        minItems: 0,
        blankProbability: 1,
      },
    }`,
  ],
])(
  'text budget %s',
  (_regression, fields) => {
    guardedGeneration(`
      const rules = rulesFor(${fields});
      assert.throws(() => generate(rules, 'text-limit'), error => {
        assert.ok(error instanceof InvalidRulesError, 'expected InvalidRulesError');
        assert.ok(error.issues.some(issue =>
          JSON.stringify(issue.path) === '["fields"]'), 'expected a record-level fields issue');
        return true;
      }, 'expected oversized text to be rejected before generation');
    `);
  },
  15_000,
);

test('text budget accepts exactly one million characters summed across fields', () => {
  guardedGeneration(`
    const rules = rulesFor(Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => ['text' + i, text(100_000)])
    ));
    const record = generate(rules, 'text-fields-boundary');
    assert.equal(Object.keys(record).length, 10);
    for (const value of Object.values(record)) assert.equal(value.length, 100_000);
  `);
}, 15_000);

test('text budget accepts exactly one million characters multiplied across array rows', () => {
  guardedGeneration(`
    const record = generate(rulesFor({
      rows: array(1_000, object({ value: text(1_000) })),
    }), 'text-array-boundary');
    assert.equal(record.rows.length, 1_000);
    for (const row of record.rows) assert.equal(row.value.length, 1_000);
  `);
}, 15_000);

test('running balances reuse a shared opening total across 20000 nested row groups', () => {
  guardedGeneration(`
    const record = generate(rulesFor({
      opening: array(20_000, constant(1)),
      groups: array(20_000, object({
        rows: array(1, object({
          b: { type: 'runningBalance', opening: 'opening[]', add: [], subtract: [] },
        })),
      })),
    }), 'shared-opening');
    assert.equal(record.opening.length, 20_000);
    assert.equal(record.groups.length, 20_000);
    for (const group of record.groups) assert.deepEqual(group.rows, [{ b: 20_000 }]);
  `);
}, 15_000);

test('running balances reuse a million-character opening path across 20000 nested row groups', () => {
  guardedGeneration(`
    const longName = 'x'.repeat(1_000_000);
    const record = generate(rulesFor({
      [longName]: constant(37),
      groups: array(20_000, object({
        rows: array(1, object({
          b: { type: 'runningBalance', opening: longName, add: [], subtract: [] },
        })),
      })),
    }), 'long-opening-path');
    assert.equal(record[longName], 37);
    assert.equal(record.groups.length, 20_000);
    for (const group of record.groups) assert.deepEqual(group.rows, [{ b: 37 }]);
  `);
}, 15_000);

test('sum reuses a 20000-item column repeated 5000 times without losing multiplicity or decimal precision', () => {
  guardedGeneration(`
    const record = generate(rulesFor({
      rows: array(20_000, object({ d: constant(0.1) })),
      total: { type: 'sum', of: Array(5_000).fill('rows[].d') },
    }), 'repeated-sum');
    assert.equal(record.rows.length, 20_000);
    assert.equal(record.total, 10_000_000);
  `);
}, 15_000);

test('running balances collapse 100000 repeated add paths across 20000 rows while preserving every prefix', () => {
  guardedGeneration(`
    const record = generate(rulesFor({
      opening: constant(0),
      rows: array(20_000, object({
        d: constant(1),
        b: {
          type: 'runningBalance', opening: 'opening',
          add: Array(100_000).fill('rows[].d'), subtract: [],
        },
      })),
    }), 'repeated-add');
    assert.equal(record.rows.length, 20_000);
    for (const [i, row] of record.rows.entries()) {
      assert.equal(row.b, 100_000 * (i + 1), 'wrong balance at row ' + i);
    }
  `);
}, 15_000);

test('distinct sums share the empty-array prefix across 20000 rows and 5000 columns promptly', () => {
  guardedGeneration(`
    const columns = Array.from({ length: 5_000 }, (_, i) => 'v' + i);
    // Only 5,000 generated leaves and derived steps: empty items generate none.
    const rules = rulesFor({
      rows: array(20_000, object({
        empty: array(0, object(Object.fromEntries(columns.map(key => [key, constant(1)])))),
      })),
      ...Object.fromEntries(columns.map(key => [
        'sum_' + key, { type: 'sum', of: ['rows[].empty[].' + key] },
      ])),
    });
    const start = performance.now();
    const record = generate(rules, 'shared-empty-prefix');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2_000, 'shared empty prefix took ' + elapsed.toFixed(1) + ' ms');
    assert.equal(record.rows.length, 20_000);
    for (const row of record.rows) assert.deepEqual(row, { empty: [] });
    for (const key of columns) assert.equal(record['sum_' + key], 0, key);
  `);
}, 15_000);

test('distinct sums and percentages share populated column prefixes across 2000 rows promptly', () => {
  guardedGeneration(`
    const columns = Array.from({ length: 40 }, (_, i) => ['v' + i, i + 3]);
    const rules = rulesFor({
      rows: array(2_000, object({
        c: object(Object.fromEntries(columns.map(([key, value]) => [key, constant(value)]))),
      })),
      ...Object.fromEntries(columns.flatMap(([key]) => [
        ['sum_' + key, { type: 'sum', of: ['rows[].c.' + key] }],
        ['ratio_' + key, {
          type: 'percentage', part: 'rows[].c.' + key, whole: 'rows[].c.v0', decimals: 2,
        }],
      ])),
    });
    const start = performance.now();
    const record = generate(rules, 'shared-populated-prefix');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2_000, 'shared populated prefix took ' + elapsed.toFixed(1) + ' ms');
    assert.equal(record.rows.length, 2_000);
    for (const [key, value] of columns) {
      const expectedSum = 2_000 * value;
      const expectedPercentage = Math.round(expectedSum * 10_000 / (2_000 * 3)) / 100;
      assert.equal(record['sum_' + key], expectedSum, key);
      assert.equal(record['ratio_' + key], expectedPercentage, key);
    }
  `);
}, 15_000);

test('running balances share deep distinct add prefixes across 1000 rows and 20 balances promptly', () => {
  guardedGeneration(`
    const values = Array.from({ length: 40 }, (_, i) => i + 1);
    let nested = object(Object.fromEntries(values.map(value => ['v' + (value - 1), constant(value)])));
    // rows is level 1, its item level 2, 29 objects levels 3–31, constants level 32.
    for (let i = 1; i < 29; i++) nested = object({ child: nested });
    const prefix = 'rows[].deep.' + 'child.'.repeat(28);
    const paths = values.map((_, i) => prefix + 'v' + i);
    // 1,000 × 20 × 40 = 800,000 derived steps; 60,001 generated leaves.
    const rules = rulesFor({
      opening: constant(17),
      rows: array(1_000, object({
        deep: nested,
        ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
          'b' + i, { type: 'runningBalance', opening: 'opening', add: paths, subtract: [] },
        ])),
      })),
    });
    const start = performance.now();
    const record = generate(rules, 'shared-deep-row-prefix');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2_000, 'shared deep row prefix took ' + elapsed.toFixed(1) + ' ms');
    assert.equal(record.rows.length, 1_000);
    const increment = values.reduce((sum, value) => sum + value, 0);
    for (const [i, row] of record.rows.entries()) {
      for (let b = 0; b < 20; b++) {
        assert.equal(row['b' + b], 17 + (i + 1) * increment, 'row ' + i + ', balance ' + b);
      }
    }
  `);
}, 15_000);

test.each([
  [
    'bounds cycle diagnostics for 500 repeated back edges instead of expanding every cycle path',
    "Array(500).fill('f0')",
  ],
  [
    'bounds cycle diagnostics for 499 distinct back edges instead of expanding every cycle path',
    "Array.from({ length: 499 }, (_, i) => 'f' + i)",
  ],
])(
  '%s',
  (_regression, backEdges) => {
    guardedGeneration(`
      const fields = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [
        'f' + i,
        { type: 'sum', of: i === 499 ? ${backEdges} : ['f' + (i + 1)] },
      ]));
      const rules = rulesFor(fields);
      assert.throws(() => generate(rules, 'bounded-cycle-diagnostics'), error => {
        assert.ok(error instanceof InvalidRulesError,
          'expected InvalidRulesError for cyclic sums; got ' + error.name + ': ' + error.message.slice(0, 120));
        assert.ok(error.issues.length > 0, 'expected a cycle diagnostic');
        assert.ok(error.issues.length <= 500,
          'expected at most one issue per derived field; got ' + error.issues.length + ' issues');
        const cycleIssues = error.issues.filter(issue =>
          issue.path[0] === 'fields' && Object.hasOwn(fields, issue.path[1]));
        assert.ok(cycleIssues.length > 0, 'expected an issue path identifying a cycle member');
        assert.equal(new Set(cycleIssues.map(issue => issue.path[1])).size,
          cycleIssues.length, 'expected each cycle member to be reported at most once');
        assert.ok(error.message.length < 1_000_000, 'expected a bounded cycle error message');
        return true;
      });
    `);
  },
  15_000,
);

test.each([
  [
    'keeps every printed balance of extreme-magnitude constants fast and exact (largest opening, smallest-denormal add/subtract)',
    '1.7976931348623157e308',
  ],
  [
    'keeps every printed balance of denormal add/subtract constants fast and exact (opening 1)',
    '1',
  ],
])(
  '%s',
  (_regression, opening) => {
    guardedGeneration(`
      const opening = ${opening};
      // 8,000 rows × 10 balances = 80,000 derived steps; ~96,000 values.
      const rules = rulesFor({
        opening: constant(opening),
        rows: array(8_000, object({
          p: constant(5e-324),
          q: constant(5e-324),
          ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
            'b' + i,
            { type: 'runningBalance', opening: 'opening', add: ['rows[].p'], subtract: ['rows[].q'] },
          ])),
        })),
      });
      const start = performance.now();
      const record = generate(rules, 'extreme-constants');
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 2_000, 'extreme constants took ' + elapsed.toFixed(1) + ' ms');
      assert.equal(record.rows.length, 8_000);
      for (const [i, row] of record.rows.entries()) {
        for (let b = 0; b < 10; b++) {
          assert.equal(row['b' + b], opening, 'row ' + i + ', balance ' + b);
        }
      }
    `);
  },
  15_000,
);

test('running balances deep inside nested arrays stay fast for 99000 rows × 10 paths × 31 levels', () => {
  guardedGeneration(`
    // 13 single-item wrappers + the rows array put each balance at level 31
    // and its z leaves at level 32: 99,000 values, 990,000 derived steps.
    const prefix = Array(14).fill('a[]').join('.');
    const paths = Array.from({ length: 10 }, (_, i) => prefix + '.z[].v' + i);
    let nest = array(99_000, object({
      bal: { type: 'runningBalance', opening: 'o', add: paths, subtract: [] },
      z: array(0, object(Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => ['v' + i, constant(1)])))),
    }));
    for (let i = 0; i < 13; i++) nest = array(1, object({ a: nest }));
    const rules = rulesFor({ o: constant(0), a: nest });
    const start = performance.now();
    const record = generate(rules, 'deep-balance-lookup');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3_000, 'deep balance lookups took ' + elapsed.toFixed(1) + ' ms');
    let rows = record.a;
    for (let i = 0; i < 13; i++) {
      assert.equal(rows.length, 1);
      rows = rows[0].a;
    }
    assert.equal(rows.length, 99_000);
    for (const [i, row] of rows.entries()) assert.equal(row.bal, 0, 'row ' + i);
  `);
}, 15_000);

test('running balances deep inside nested arrays keep every prefix over non-empty inner arrays', () => {
  guardedGeneration(`
    const prefix = Array(14).fill('a[]').join('.');
    const paths = Array.from({ length: 10 }, (_, i) => prefix + '.z[].v' + i);
    let nest = array(9_000, object({
      bal: { type: 'runningBalance', opening: 'o', add: paths, subtract: [] },
      z: array(1, object(Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => ['v' + i, constant(1)])))),
    }));
    for (let i = 0; i < 13; i++) nest = array(1, object({ a: nest }));
    const rules = rulesFor({ o: constant(0), a: nest });
    const start = performance.now();
    const record = generate(rules, 'deep-balance-prefixes');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3_000, 'deep balance prefixes took ' + elapsed.toFixed(1) + ' ms');
    let rows = record.a;
    for (let i = 0; i < 13; i++) {
      assert.equal(rows.length, 1);
      rows = rows[0].a;
    }
    assert.equal(rows.length, 9_000);
    for (const [i, row] of rows.entries()) {
      assert.equal(row.bal, 10 * (i + 1), 'wrong balance at row ' + i);
    }
  `);
}, 15_000);

test.each([
  ['empty', 1_000, 0, 0],
  ['populated', 100, 1, 100],
])(
  'running balances share a deep %s array path below a row across 500 balances promptly',
  (_regression, outerCount, leafCount, expected) => {
    guardedGeneration(
      `
      const lengths = [${outerCount}, ...Array(12).fill(1), ${leafCount}];
      // Each array item is an object containing the next a array.
      // rows is level 1, its item level 2, and v is level 31.
      let nested = object({ v: constant(1) });
      for (const length of lengths.toReversed()) {
        nested = object({ a: array(length, nested) });
      }
      const path = 'rows[].' + 'a[].'.repeat(14) + 'v';
      // Empty: 501 values, 500,000 steps. Populated: 601 values, 50,000 steps.
      const rules = rulesFor({
        opening: constant(0),
        rows: array(1, object({
          ...nested.fields,
          ...Object.fromEntries(Array.from({ length: 500 }, (_, i) => [
            'b' + i,
            { type: 'runningBalance', opening: 'opening', add: [path], subtract: [] },
          ])),
        })),
      });
      const start = performance.now();
      const record = generate(rules, 'shared-deep-array-balance-path');
      const elapsed = performance.now() - start;
      assert.equal(record.opening, 0);
      assert.equal(record.rows.length, 1);
      for (let b = 0; b < 500; b++) {
        assert.equal(record.rows[0]['b' + b], ${expected}, 'balance ' + b);
      }
      assert.ok(elapsed < 1_500, 'shared deep ${_regression} array path took ' + elapsed.toFixed(1) + ' ms');
    `,
      10_000,
    );
  },
  15_000,
);

test('running balances share 100000 empty rows arrays across 4000 balances promptly', () => {
  guardedGeneration(
    `
    const fieldsFor = balance => ({
      o: constant(0),
      a: array(1_000, object({
        b: array(100, object({
          empty: array(0, object(Object.fromEntries(
            Array.from({ length: 4_000 }, (_, i) => ['b' + i, balance()])
          ))),
        })),
      })),
    });
    // Seven levels, one generated leaf and zero derived steps: no balance exists.
    const rules = rulesFor(fieldsFor(() => ({
      type: 'runningBalance', opening: 'o', add: [], subtract: [],
    })));
    const constantRules = rulesFor(fieldsFor(() => constant(0)));
    const expected = generate(constantRules, 'shared-empty-rows');
    assert.equal(expected.a.length, 1_000);
    for (const outer of expected.a) {
      assert.equal(outer.b.length, 100);
      for (const inner of outer.b) assert.deepEqual(inner.empty, []);
    }
    const start = performance.now();
    const record = generate(rules, 'shared-empty-rows');
    const elapsed = performance.now() - start;
    assert.deepEqual(record, expected);
    assert.ok(elapsed < 1_500, 'shared empty rows arrays took ' + elapsed.toFixed(1) + ' ms');
  `,
    10_000,
  );
}, 15_000);

test('running balances sharing populated rows arrays keep every prefix independent across groups', () => {
  guardedGeneration(
    `
    // 90 × 5 × 201 + the opening = 90,451 values, below the 100,000 cap.
    const rules = rulesFor({
      o: constant(0),
      a: array(90, object({
        rows: array(5, object({
          d: constant(1),
          ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [
            'b' + i,
            { type: 'runningBalance', opening: 'o', add: ['a[].rows[].d'], subtract: [] },
          ])),
        })),
      })),
    });
    const record = generate(rules, 'shared-populated-rows');
    assert.equal(record.o, 0);
    assert.equal(record.a.length, 90);
    for (const [groupIndex, group] of record.a.entries()) {
      assert.equal(group.rows.length, 5);
      for (const [rowIndex, row] of group.rows.entries()) {
        assert.equal(row.d, 1);
        for (let b = 0; b < 200; b++) {
          assert.equal(row['b' + b], rowIndex + 1,
            'group ' + groupIndex + ', row ' + rowIndex + ', balance ' + b);
        }
      }
    }
  `,
    10_000,
  );
}, 15_000);
