import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

function check(body: string) {
  const script = `
    import assert from 'node:assert/strict';
    import { ruleLimits } from '@pdf-generator/contract';
    import { generate, InvalidRulesError } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const constant = { type: 'constant', value: 7 };
    const leaves = count => Object.fromEntries(Array.from({ length: count }, (_, i) => ['v' + i, constant]));
    const rules = fields => ({ schemaVersion: 1, fields });
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

test.each(['root', 'object', 'array'])(
  'generates every value at the contract maxValues boundary for a wide %s',
  shape => {
    check(`
      const shape = ${JSON.stringify(shape)};
      const count = ruleLimits.maxValues - (shape === 'root' ? 0 : 1);
      const fields = shape === 'root' ? leaves(count) : {
        wide: shape === 'object' ? { type: 'object', fields: leaves(count) } : {
          type: 'array', minItems: count, maxItems: count, items: constant,
        },
      };
      const record = generate(rules(fields), 'contract-wide-boundary');
      const values = shape === 'root' ? record : record.wide;
      assert.equal(Object.keys(values).length, count);
      for (let i = 0; i < count; i++) {
        assert.equal(values[shape === 'array' ? i : 'v' + i], 7, 'missing value ' + i);
      }
    `);
  },
  130_000,
);

test.each(['root', 'object', 'array'])(
  'rejects one value over the contract budget for a wide %s with a fields issue',
  shape => {
    check(`
      const shape = ${JSON.stringify(shape)};
      const count = ruleLimits.maxValues + (shape === 'root' ? 1 : 0);
      const fields = shape === 'root' ? leaves(count) : {
        wide: shape === 'object' ? { type: 'object', fields: leaves(count) } : {
          type: 'array', minItems: count, maxItems: count, items: constant,
        },
      };
      assert.throws(() => generate(rules(fields), 'contract-wide-overflow'), error => {
        assert.ok(error instanceof InvalidRulesError);
        assert.ok(error.issues.some(issue => JSON.stringify(issue.path) === '["fields"]' &&
          issue.message.includes(String(ruleLimits.maxValues))));
        return true;
      });
    `);
  },
  130_000,
);

test.each(['object', 'array'])(
  'uses the contract depth boundary for nested %s rules',
  shape => {
    check(`
      const shape = ${JSON.stringify(shape)};
      const nest = levels => {
        let field = constant;
        for (let level = 1; level < levels; level++) field = shape === 'object'
          ? { type: 'object', fields: { child: field } }
          : { type: 'array', minItems: 1, maxItems: 1, items: field };
        return field;
      };
      let value = generate(rules({ nest: nest(ruleLimits.maxLevels) }), 'contract-depth').nest;
      for (let i = 1; i < ruleLimits.maxLevels; i++) value = shape === 'object' ? value.child : value[0];
      assert.equal(value, 7);
      const path = ['fields', 'nest'];
      for (let i = 0; i < ruleLimits.maxLevels; i++) path.push(...(shape === 'object' ? ['fields', 'child'] : ['items']));
      assert.throws(() => generate(rules({ nest: nest(ruleLimits.maxLevels + 1) }), 'contract-depth'), error => {
        assert.ok(error instanceof InvalidRulesError);
        assert.ok(error.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(path) &&
          issue.message.includes(String(ruleLimits.maxLevels))));
        return true;
      });
    `);
  },
  130_000,
);
