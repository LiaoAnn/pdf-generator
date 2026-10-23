import { z } from 'zod';
import { manifestSchema } from './manifest.ts';

/** Every contract published as JSON Schema, by file name. */
export const contractSchemas = {
  manifest: manifestSchema,
} as const satisfies Record<string, z.ZodType>;

/**
 * The draft 2020-12 JSON Schema of every contract, as committed in
 * `schemas/<name>.schema.json`. Cross-field rules (zod refinements) are not
 * expressible there; each schema's description lists them.
 */
export function jsonSchemas(): Record<string, z.core.JSONSchema.BaseSchema> {
  return Object.fromEntries(
    Object.entries(contractSchemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        unrepresentable: 'throw',
      }),
    ]),
  );
}
