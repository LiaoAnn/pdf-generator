import { execFileSync } from 'node:child_process';
import type { Rules } from '@pdf-generator/contract';
import { expect, test } from 'vitest';
import { generate } from './engine.ts';

test('long ancestor keys do not multiply random-stream derivation work by the number of values', () => {
  // Run both workloads in one fresh process, away from Vitest transforms.
  // The ratio detects repeated path hashing without a machine-specific ms bound.
  const script = `
    import assert from 'node:assert/strict';
    import { generate } from ${JSON.stringify(new URL('./engine.ts', import.meta.url).href)};
    const count = 4_000;
    const rulesFor = key => ({ schemaVersion: 1, fields: {
      [key]: { type: 'object', fields: {
        rows: { type: 'array', minItems: count, maxItems: count,
          items: { type: 'integer', min: 0, max: 1_000_000, blankProbability: 0.25 } },
      } },
    } });
    const keys = ['x', 'x'.repeat(100_000)];
    const rules = keys.map(rulesFor);
    const samples = [[], []];
    const measure = (variant, seed) => {
      const start = performance.now();
      const record = generate(rules[variant], seed);
      const elapsed = performance.now() - start;
      assert.equal(record[keys[variant]].rows.length, count);
      return elapsed;
    };
    // Warm both shapes, then alternate which runs first to limit order bias.
    for (const variant of [0, 1]) measure(variant, 'warmup');
    for (let round = 0; round < 5; round++) {
      for (const variant of round % 2 === 0 ? [0, 1] : [1, 0]) {
        samples[variant].push(measure(variant, 'timing-' + round));
      }
    }
    const median = values => values.toSorted((a, b) => a - b)[2];
    const [short, long] = samples.map(median);
    assert.ok(long <= short * 3,
      'long-key median ' + long.toFixed(2) + ' ms / short-key median ' +
      short.toFixed(2) + ' ms = ' + (long / short).toFixed(2) + 'x; expected <= 3x');
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}, 70_000);

test('nested paths, sibling names and array indices retain distinct value streams', () => {
  const integer = { type: 'integer', min: 0, max: 1_000_000 } as const;
  const rules: Rules = {
    schemaVersion: 1,
    fields: {
      a: { type: 'object', fields: { b: integer } },
      b: integer,
      ab: integer,
      a_b: integer,
      rows: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { type: 'object', fields: { b: integer } },
      },
    },
  };
  const paths = ['a.b', 'b', 'ab', 'a_b', 'rows.0.b', 'rows.1.b'];
  const vectors = paths.map(() => [] as unknown[]);
  // Compare short vectors, rather than requiring every single draw to differ.
  for (let sample = 0; sample < 8; sample++) {
    const record = generate(rules, `path-independence-${sample}`);
    paths.forEach((path, index) => {
      const value = path.split('.').reduce<unknown>((parent, key) => {
        if (parent === null || typeof parent !== 'object') {
          throw new Error(`Missing generated path ${path}`);
        }
        return (parent as Record<string, unknown>)[key];
      }, record);
      expect(typeof value, path).toBe('number');
      vectors[index]?.push(value);
    });
  }
  expect(new Set(vectors.map(vector => JSON.stringify(vector))).size).toBe(
    paths.length,
  );
});
