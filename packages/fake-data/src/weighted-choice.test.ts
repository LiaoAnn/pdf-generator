import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RuleField } from '@pdf-generator/contract';
import { expect, test } from 'vitest';
import { generate } from './index.ts';
import { createRng } from './random.ts';

const vectors = [
  [0, 1, 3],
  [1, 0, 3],
  [1, 3, 0],
  [0, 0, 1, 0],
  [1, 1, 1, 1],
  [Number.MIN_VALUE, Number.MIN_VALUE * 2, 0, Number.MIN_VALUE],
  [Number.MAX_VALUE, 0, Number.MAX_VALUE / 2, Number.MAX_VALUE],
  [Number.MIN_VALUE, 1, Number.MAX_VALUE],
  [0.1, 0.2, 0.7, 1.25],
  Array.from({ length: 10_000 }, (_, i) => (i % 7 === 0 ? 0 : i + 0.25)),
];

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Captured from the pre-T05-3 implementation, including its scaling and
// floating-point summation order. These are compatibility pins, not an oracle
// reimplementing weighted selection.
test.each([
  [
    'weighted-compat',
    '1cd8460ee89b6eb7d8c65f77faceb03b86821c29bd5bee1c7f4196e283bd2edc',
    '354e480d79a12974d6089ffb483416b2dc3ce0db9acc3ea2c67ebef919bad540',
  ],
  [
    'T05_3-boundary',
    'b64017c86a86dd33aff090960b3e5d8bdbb1ba4dd47d9fecb0f890487ec5c100',
    '6e0c397d985d5e278940ee86dc0996862f0dec8e40ab2387ea79f4bdececbbcb',
  ],
  [
    '0',
    '0f59f05d9d3d0f4c1c8dc56d89bda5654d46c7c8fa34286a00204d036342f7d1',
    '31b497c76bf26bffa9a3b3043cf1ffbe44c06746c184816ff50d6cc6e42e440e',
  ],
] as const)(
  'preserves pre-T05-3 weighted records and successive direct RNG draws for seed %s',
  (seed, recordHash, rngHash) => {
    const records = [];
    const draws = [];
    for (const weights of vectors) {
      const options = weights.map((_, i) => i);
      const leaf: RuleField = { type: 'choice', options, weights };
      records.push(
        generate(
          {
            schemaVersion: 1,
            fields: {
              single: leaf,
              rows: {
                type: 'array',
                minItems: 128,
                maxItems: 128,
                items: {
                  type: 'object',
                  fields: {
                    value: leaf,
                    blank: { ...leaf, blankProbability: 0.3 },
                  },
                },
              },
            },
          },
          seed,
        ),
      );
      const rng = createRng(seed, 'weighted-compat');
      draws.push(
        Array.from({ length: 512 }, () => [
          rng.weighted(options, weights),
          rng.int(0, 1_000_000),
        ]),
      );
    }
    expect.soft(hash(records)).toBe(recordHash);
    expect.soft(hash(draws)).toBe(rngHash);
  },
);

test('weighted choice with 10000 options amortizes its weights across 77000 array values', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { generate } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const options = Array.from({ length: 10_000 }, (_, i) => i);
    const make = weighted => ({ schemaVersion: 1, fields: {
      rows: { type: 'array', minItems: 77_000, maxItems: 77_000,
        items: { type: 'choice', options, ...(weighted ? { weights: options.map(i => i % 5 + 1) } : {}) } },
    } });
    const inputs = [make(false), make(true)];
    const run = which => {
      const record = generate(inputs[which], 'weighted-performance');
      assert.equal(record.rows.length, 77_000);
      for (const value of record.rows) assert.ok(Number.isInteger(value) && value >= 0 && value < options.length);
    };
    run(0); run(1);
    const samples = [[], []];
    for (let round = 0; round < 3; round++) {
      for (const which of (round % 2 ? [1, 0] : [0, 1])) {
        const start = performance.now();
        run(which);
        samples[which].push(performance.now() - start);
      }
    }
    const median = xs => xs.sort((a, b) => a - b)[1];
    const baseline = median(samples[0]);
    const weighted = median(samples[1]);
    const ratio = weighted / baseline;
    assert.ok(ratio < 6, 'weighted median ' + weighted.toFixed(1) + ' ms / unweighted median ' + baseline.toFixed(1) +
      ' ms = ' + ratio.toFixed(2) + '; expected ratio < 6');
    process.stdout.write('ok');
  `;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 300_000,
    }),
  ).toBe('ok');
}, 310_000);
