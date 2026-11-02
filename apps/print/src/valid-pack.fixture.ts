// T06's valid example pack (its own font, image and stylesheet), read for
// print tests: its files as /print and PUT /batch/<id>/pack send them, and
// its template filled with the sample data or with other values.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { manifestSchema } from '../../../packages/contract/src/index.ts';
import { fill } from '../../../packages/template-tools/src/index.ts';

export interface ValidPack {
  page: { size: 'A4'; orientation: 'portrait' | 'landscape' };
  /** The pack path of the template (manifest files.template). */
  template: string;
  /** Every file of the pack, by pack path, as base64. */
  files: Record<string, string>;
  /** The template filled with `values` over the sample data. */
  html: (values?: Record<string, unknown>) => string;
}

export async function readValidPack(): Promise<ValidPack> {
  const root = new URL(
    '../../../packages/template-tools/fixtures/valid/',
    import.meta.url,
  );
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(fileURLToPath(root), path)] = (
      await readFile(path)
    ).toString('base64');
  }
  const text = (path: string) =>
    Buffer.from(files[path] ?? '', 'base64').toString('utf8');
  const manifest = manifestSchema.parse(JSON.parse(text('manifest.json')));
  const template = text(manifest.files.template);
  const sample = JSON.parse(text(manifest.files.sample)) as Record<
    string,
    unknown
  >;
  return {
    page: manifest.page,
    template: manifest.files.template,
    files,
    html: (values = {}) => fill(template, { ...sample, ...values }),
  };
}
