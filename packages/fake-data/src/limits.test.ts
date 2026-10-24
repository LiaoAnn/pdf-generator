import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

// Kill synchronous CPU exhaustion without wedging the Vitest worker. Keep
// assertions in the child so large records never need to cross stdout.
function guardedGeneration(body: string) {
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
      timeout: 10_000,
    }),
  ).toBe('ok');
}

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
