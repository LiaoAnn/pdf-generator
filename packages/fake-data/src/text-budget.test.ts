import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

function check(body: string) {
  const script = `
    import assert from 'node:assert/strict';
    import { ruleLimits } from '@pdf-generator/contract';
    import { generate, InvalidRulesError } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const constant = value => ({ type: 'constant', value });
    const choice = options => ({ type: 'choice', options });
    const array = (count, items) => ({ type: 'array', minItems: count, maxItems: count, items });
    const rules = fields => ({ schemaVersion: 1, fields });
    const rejected = input => assert.throws(() => generate(input, 'text-budget'), error => {
      assert.ok(error instanceof InvalidRulesError);
      assert.ok(error.issues.some(issue => JSON.stringify(issue.path) === '["fields"]' &&
        issue.message.includes(String(ruleLimits.maxTextCharacters))));
      return true;
    });
    ${body}
    process.stdout.write('ok');
  `;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 120_000,
    }),
  ).toBe('ok');
}

test.each(['constant', 'choice'])(
  'rejects compact %s amplification through every enclosing maxItems before generation',
  kind => {
    check(`
      const payload = 'x'.repeat(Math.floor(ruleLimits.maxTextCharacters / 50));
      const leaf = ${kind === 'constant' ? 'constant(payload)' : '({ ...choice([false, payload, 1]), weights: [1, 0, 0] })'};
      // About 20 KB describes over a billion characters. No items are drawn:
      // rejection must charge maxItems, not the actual length or selected option.
      const input = rules({ rows: { ...array(250, array(300, leaf)), minItems: 0, blankProbability: 1 } });
      assert.ok(Buffer.byteLength(JSON.stringify(input)) < 30_000);
      rejected(input);
    `);
  },
  130_000,
);

test.each(['constant', 'choice', 'mixed'])(
  'accepts exactly the text budget from %s fields and rejects one more character',
  kind => {
    check(`
      const kind = ${JSON.stringify(kind)};
      const limit = ruleLimits.maxTextCharacters;
      const fields = kind === 'constant' ? { value: constant('甲'.repeat(limit)) }
        : kind === 'choice' ? { value: choice(['乙'.repeat(limit), '短', false, 42]) }
        : {
          a: constant('甲'.repeat(Math.floor(limit / 3))),
          b: choice(['乙'.repeat(Math.floor(limit / 3)), '短']),
          c: { type: 'text', lang: 'zh', minLength: limit - 2 * Math.floor(limit / 3), maxLength: limit - 2 * Math.floor(limit / 3) },
        };
      // Force longest options so the generated boundary is observable too.
      if (kind === 'choice') fields.value.weights = [1, 0, 0, 0];
      if (kind === 'mixed') fields.b.weights = [1, 0];
      const record = generate(rules(fields), 'text-exact-boundary');
      assert.equal(Object.values(record).reduce((n, value) => n + value.length, 0), limit);
      rejected(rules({ ...fields, extra: constant('多') }));
    `);
  },
  130_000,
);

test('array text budget counts the longest option once, excluding non-string values and keys', () => {
  check(`
    const count = 1_000;
    const length = Math.floor(ruleLimits.maxTextCharacters / count);
    const key = 'k'.repeat(64);
    const fields = {
      [key]: array(count, choice(['甲'.repeat(length), '乙'.repeat(length), false, Number.MAX_VALUE])),
      number: constant(Number.MAX_VALUE), bool: constant(true),
      nonString: array(100, choice([true, false, 1e100])),
      empty: array(0, constant('不'.repeat(ruleLimits.maxTextCharacters + 1))),
    };
    const record = generate(rules(fields), 'text-options-boundary');
    assert.equal(record[key].length, count);
    assert.equal(record.number, Number.MAX_VALUE);
    assert.equal(record.bool, true);
    assert.equal(record.nonString.length, 100);
    assert.deepEqual(record.empty, []);
    rejected(rules({ ...fields, extra: constant('多') }));
  `);
}, 130_000);
