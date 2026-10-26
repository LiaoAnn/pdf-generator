import type { Rules } from '@pdf-generator/contract';
import { expect, test } from 'vitest';
import { generate } from './engine.ts';

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
