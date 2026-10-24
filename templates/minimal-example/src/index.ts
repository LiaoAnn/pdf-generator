import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackFiles } from '@pdf-generator/template-tools';
import { zipSync } from 'fflate';

const packDir = fileURLToPath(new URL('../pack', import.meta.url));

/** Every file under pack/, by its '/'-separated path relative to pack/. */
export function packFiles(): PackFiles {
  return readPack();
}

/** pack/ as the zip an upload sends: its files at the zip root. */
export function packZip(): Uint8Array {
  return zipSync(readPack());
}

function readPack(): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(packDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const file = join(entry.parentPath, entry.name);
        return [
          relative(packDir, file).split(sep).join('/'),
          new Uint8Array(readFileSync(file)),
        ];
      }),
  );
}
