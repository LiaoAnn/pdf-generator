import { z } from 'zod';
import { blockListSchema } from './block-list.ts';
import { gtSchema } from './ground-truth.ts';
import { manifestSchema } from './manifest.ts';
import { rulesSchema } from './rules.ts';

/** Every contract published as JSON Schema, by file name. */
export const contractSchemas = {
  manifest: manifestSchema,
  rules: rulesSchema,
  gt: gtSchema,
  'block-list': blockListSchema,
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
      withoutTypeArrays(
        z.toJSONSchema(schema, {
          target: 'draft-2020-12',
          unrepresentable: 'throw',
        }),
      ),
    ]),
  );
}

/**
 * Rewrites `type: [...]` as `anyOf`, in place: Ajv's strict mode, which local
 * consumers may use, rejects union types.
 */
function withoutTypeArrays<T>(node: T): T {
  if (Array.isArray(node)) {
    for (const item of node) withoutTypeArrays(item);
  } else if (typeof node === 'object' && node !== null) {
    const schema = node as Record<string, unknown>;
    if (Array.isArray(schema.type)) {
      schema.anyOf = schema.type.map(type => ({ type }));
      delete schema.type;
    }
    for (const value of Object.values(schema)) withoutTypeArrays(value);
  }
  return node;
}
