import { readFileSync } from 'node:fs';

/** The canonical Word-style stylesheet that packs copy into their own files. */
export function wordCss(): string {
  return readFileSync(new URL('../word.css', import.meta.url), 'utf8');
}
