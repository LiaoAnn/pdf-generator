// Writes <dir>/<name>.schema.json for every contract, replacing the schema
// files already there; <dir> defaults to the package's schemas/. Run with
// `pnpm --filter @pdf-generator/contract schemas`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemas } from './json-schema.ts';

const dir = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../schemas/', import.meta.url)),
);
mkdirSync(dir, { recursive: true });
for (const file of readdirSync(dir)) {
  if (file.endsWith('.schema.json')) rmSync(join(dir, file));
}
for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(
    join(dir, `${name}.schema.json`),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
  console.log(join(dir, `${name}.schema.json`));
}
