import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { contractSchemas, jsonSchemas } from './index.ts';

function committedSchemas() {
  const dir = new URL('../schemas/', import.meta.url);
  return Object.fromEntries(
    readdirSync(dir).map(name => {
      const file = new URL(name, dir);
      return [
        name,
        {
          content: readFileSync(file, 'utf8'),
          modified: statSync(file).mtimeMs,
        },
      ];
    }),
  );
}

test('export CLI writes exact schemas to the requested directory, removes only stale schemas and leaves committed schemas untouched', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'contract-export-'));
  const before = committedSchemas();
  try {
    writeFileSync(join(outDir, 'old.schema.json'), '{}\n');
    writeFileSync(join(outDir, 'README.md'), 'keep me\n');
    execFileSync(process.execPath, ['src/export-json-schemas.ts', outDir], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
    });
    expect.soft(committedSchemas()).toEqual(before);
    expect
      .soft(readdirSync(outDir).sort())
      .toEqual(
        [
          ...Object.keys(contractSchemas).map(name => `${name}.schema.json`),
          'README.md',
        ].sort(),
      );
    expect
      .soft(readFileSync(join(outDir, 'README.md'), 'utf8'))
      .toBe('keep me\n');
    const schemas = jsonSchemas();
    for (const name of Object.keys(contractSchemas)) {
      // A missing output is an export failure, not a test setup failure.
      expect.soft(readdirSync(outDir)).toContain(`${name}.schema.json`);
      if (readdirSync(outDir).includes(`${name}.schema.json`))
        expect
          .soft(readFileSync(join(outDir, `${name}.schema.json`), 'utf8'))
          .toBe(`${JSON.stringify(schemas[name], null, 2)}\n`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
