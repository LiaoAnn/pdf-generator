import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { contractSchemas, jsonSchemas } from './index.ts';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

describe('published JSON Schema contract', () => {
  test('exports and committed files cover exactly the registered contracts', () => {
    const names = Object.keys(contractSchemas).sort();
    expect(names).toContain('manifest');
    expect(Object.keys(jsonSchemas()).sort()).toEqual(names);
    expect(
      readdirSync(new URL('../schemas/', import.meta.url))
        .filter(name => name.endsWith('.schema.json'))
        .sort(),
    ).toEqual(names.map(name => `${name}.schema.json`).sort());
  });

  for (const [name, schema] of Object.entries(contractSchemas)) {
    describe(name, () => {
      test('committed schema matches the source; regenerate after contract edits', () => {
        expect(
          readJson(`../schemas/${name}.schema.json`),
          'Stale JSON Schema: run pnpm --filter @pdf-generator/contract schemas',
        ).toEqual(jsonSchemas()[name]);
      });

      test('published draft 2020-12 schema compiles in strict Ajv', () => {
        const published = readJson(`../schemas/${name}.schema.json`);
        expect(published).toHaveProperty(
          '$schema',
          'https://json-schema.org/draft/2020-12/schema',
        );
        const ajv = new Ajv2020({ strict: true });
        expect(() => ajv.compile(published as object)).not.toThrow();
      });

      test('valid example remains compatible with both runtime and local consumers', () => {
        const example = readJson(`../examples/${name}.valid.json`);
        const validate = new Ajv2020({ strict: true }).compile(
          readJson(`../schemas/${name}.schema.json`) as object,
        );
        expect(schema.safeParse(example).success).toBe(true);
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      });

      test('invalid example is rejected by both runtime and local consumers', () => {
        const example = readJson(`../examples/${name}.invalid.json`);
        const validate = new Ajv2020({ strict: true }).compile(
          readJson(`../schemas/${name}.schema.json`) as object,
        );
        expect(schema.safeParse(example).success).toBe(false);
        expect(validate(example)).toBe(false);
      });
    });
  }
});
