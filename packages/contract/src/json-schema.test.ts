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

      if (name === 'api-error') {
        test('preserves optional machine-readable detail codes and rejects malformed codes in both consumers', () => {
          const validate = new Ajv2020({ strict: true }).compile(
            readJson('../schemas/api-error.schema.json') as object,
          );
          const cases: [unknown, boolean][] = [
            [undefined, true],
            ['a', true],
            ['file-missing', true],
            ['template-unknown-field', true],
            ['font_not_loaded', true],
            ['a0_-', true],
            ['', false],
            ['File-missing', false],
            ['fileMissing', false],
            ['1file', false],
            ['_file', false],
            ['-file', false],
            ['file missing', false],
            ['file:missing', false],
            ['file-missing\n', false],
            [null, false],
            [123, false],
          ];
          for (const [code, accepted] of cases) {
            const input = {
              error: {
                code: 'invalid_template_pack',
                message: 'Invalid pack',
                details: [
                  {
                    message: 'Missing file',
                    ...(code === undefined ? {} : { code }),
                  },
                  { message: 'Legacy detail without a code' },
                ],
              },
            };
            const result = schema.safeParse(input);
            const context = `detail code ${JSON.stringify(code)}`;
            expect.soft(result.success, `Zod: ${context}`).toBe(accepted);
            if (result.success)
              expect
                .soft(result.data, `Zod preserves ${context}`)
                .toEqual(input);
            expect
              .soft(
                validate(input),
                `Ajv: ${context}; ${JSON.stringify(validate.errors)}`,
              )
              .toBe(accepted);
          }
        });
      }

      if (name === 'batch' || name === 'batch-list') {
        test.each(['checkPassed', 'checkFailed'])(
          'requires a non-negative integer %s for runtime and published-schema consumers',
          field => {
            // Regression: older local consumers accept an omitted check count,
            // or runtime and published decoders disagree on its numeric domain.
            const validate = new Ajv2020({ strict: true }).compile(
              readJson(`../schemas/${name}.schema.json`) as object,
            );
            for (const value of [undefined, -1, 0.5, '1', null, 0, 1]) {
              const progress = {
                completed: 1,
                failed: 0,
                checkPassed: 0,
                checkFailed: 0,
                [field]: value,
              };
              if (value === undefined) Reflect.deleteProperty(progress, field);
              const batch = {
                id: 'Batch_01-a',
                templateId: 'monthly-report',
                templateVersion: 1,
                count: 2,
                seed: 'Seed_01-a',
                status: 'running',
                progress,
                createdAt: '2026-10-23T15:46:22.998Z',
              };
              const input = name === 'batch' ? batch : { batches: [batch] };
              const accepted = value === 0 || value === 1;
              const context = `${field}=${JSON.stringify(value)}`;
              expect
                .soft(schema.safeParse(input).success, `Zod: ${context}`)
                .toBe(accepted);
              expect.soft(validate(input), `Ajv: ${context}`).toBe(accepted);
            }
          },
        );

        test('documents the self-check total constraint that JSON Schema cannot enforce', () => {
          // Regression: exported schemas silently omit the cross-field rule,
          // so local consumers cannot discover the extra runtime requirement.
          expect(readJson(`../schemas/${name}.schema.json`)).toHaveProperty(
            'description',
            expect.stringMatching(
              /Not expressible.*checkPassed\s*\+\s*(?:progress\.)?checkFailed\s*≤\s*(?:progress\.)?completed/,
            ),
          );
        });
      }
    });
  }
});
