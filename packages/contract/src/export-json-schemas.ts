// Writes schemas/<name>.schema.json for every contract. Run with
// `pnpm --filter @pdf-generator/contract schemas`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { jsonSchemas } from './json-schema.ts';

const dir = new URL('../schemas/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const file of readdirSync(dir)) {
  if (file.endsWith('.schema.json')) rmSync(new URL(file, dir));
}
for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(
    new URL(`${name}.schema.json`, dir),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
  console.log(`schemas/${name}.schema.json`);
}
