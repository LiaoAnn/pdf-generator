import { readdirSync, readFileSync } from 'node:fs';
import type { PackFiles } from '@pdf-generator/template-tools';
import { expect } from 'vitest';

const exampleUrl = new URL(
  '../../../templates/minimal-example/pack/',
  import.meta.url,
);

type Snippet = {
  language: string;
  outcome: string;
  code: string | undefined;
  source: string;
  line: number;
};

// Track all fences so an illustrative Markdown fence cannot expose fake examples.
export function snippets(markdown: string): Snippet[] {
  const lines = markdown.split(/\r?\n/);
  const found: Snippet[] = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index] ?? '');
    if (!opening) continue;
    const fence = opening[1] ?? '';
    const info = /^(html|css) (pack-ok|pack-error)(?: (\S+))?$/.exec(
      (opening[2] ?? '').trim(),
    );
    const start = index;
    const body: string[] = [];
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    while (++index < lines.length && !close.test(lines[index] ?? '')) {
      body.push(lines[index] ?? '');
    }
    if (!info || (info[2] === 'pack-ok' && info[3])) continue;
    if (info[2] === 'pack-error' && !info[3]) continue;
    found.push({
      language: info[1] ?? '',
      outcome: info[2] ?? '',
      code: info[3],
      source: body.join('\n'),
      line: start + 1,
    });
  }
  return found;
}

function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(directory: URL, prefix: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        visit(new URL(`${entry.name}/`, directory), `${path}/`);
      else files[path] = readFileSync(new URL(entry.name, directory), 'utf8');
    }
  }
  visit(exampleUrl, '');
  return files;
}

export function packWith(language: string, source: string): PackFiles {
  const files = exampleFiles();
  const manifest = JSON.parse(files['manifest.json'] ?? '') as {
    files: { template: string; styles: string[] };
  };
  if (language === 'html') {
    const template = files[manifest.files.template] ?? '';
    expect(template, 'minimal pack must have a body to replace').toMatch(
      /<body\b[^>]*>[\s\S]*<\/body\s*>/i,
    );
    files[manifest.files.template] = template.replace(
      /(<body\b[^>]*>)[\s\S]*(<\/body\s*>)/i,
      (_match, opening: string, closing: string) =>
        `${opening}\n${source}\n${closing}`,
    );
  } else {
    expect(manifest.files.styles.length).toBeGreaterThan(1);
    const last = manifest.files.styles.at(-1);
    if (!last) throw new Error('minimal pack has no last stylesheet');
    files[last] = source;
  }
  return files;
}
