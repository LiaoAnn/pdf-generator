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
      const fields = budgetFields(50, 20, 999);
      const row = fields.rows.items.fields;
      const paths = Array.from({ length: 999 }, (_, i) => 'rows[].c.v' + i);
      row.total = { type: 'sum', of: [...paths, ...paths] };
      row.ratio = { type: 'percentage', part: 'rows[].c.v0', whole: 'rows[].c.${whole}', decimals: 0 };
      // Balances: 999,000; sum: 999 once, despite 50 instances and repeated paths;
      // percentage: 1 for identical paths, 2 for distinct paths. Under 53,000 values.
      if (${rejected}) {
        assertBudgetRejected(fields);
      } else {
        const record = generate(rulesFor(fields), 'mixed-budget-boundary');
        assert.equal(record.rows.length, 50);
        for (const i of [0, 24, 49]) {
          assert.equal(record.rows[i].b19, 999 * (i + 1));
          assert.equal(record.rows[i].total, 99_900);
          assert.equal(record.rows[i].ratio, 100);
        }
      }
    `,
      rejected ? 3_000 : 10_000,
    );
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
