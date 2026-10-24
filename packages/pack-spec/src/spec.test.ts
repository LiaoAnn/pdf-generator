import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blockTypes } from '@pdf-generator/contract';
import { checkPack, type PackFiles } from '@pdf-generator/template-tools';
import { describe, expect, it } from 'vitest';

const specUrl = new URL('../SPEC.md', import.meta.url);
const exampleUrl = new URL(
  '../../../templates/minimal-example/pack/',
  import.meta.url,
);
const attributes = [
  'data-gt',
  'data-gt-id',
  'data-gt-checked',
  'data-gt-latex',
  'data-gt-text',
];

function readSpec(): string {
  expect(existsSync(specUrl), 'packages/pack-spec/SPEC.md is missing').toBe(
    true,
  );
  return readFileSync(specUrl, 'utf8');
}

type Snippet = {
  language: string;
  outcome: string;
  code: string | undefined;
  source: string;
  line: number;
};

// Track all fences so an illustrative Markdown fence cannot expose fake examples.
function snippets(markdown: string): Snippet[] {
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

function packWith(language: string, source: string): PackFiles {
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

function tableEntries(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `### ${heading}`);
  expect(start, `SPEC.md must contain ### ${heading}`).toBeGreaterThanOrEqual(
    0,
  );
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    section.push(line);
  }
  const tableStart = section.findIndex(line => /^\s*\|/.test(line));
  expect(
    tableStart,
    `${heading} must be followed by a Markdown table`,
  ).toBeGreaterThanOrEqual(0);
  const entries: string[] = [];
  for (const line of section.slice(tableStart)) {
    if (!/^\s*\|/.test(line)) break;
    const entry = /^\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (entry?.[1]) entries.push(entry[1]);
  }
  return entries;
}

describe('pack specification stays aligned with the platform', () => {
  it.each([
    ['html', 'pack-ok'],
    ['html', 'pack-error'],
    ['css', 'pack-ok'],
    ['css', 'pack-error'],
  ])(
    'keeps at least one %s %s example so executable coverage cannot disappear',
    (language, outcome) => {
      expect(
        snippets(readSpec()).filter(
          item => item.language === language && item.outcome === outcome,
        ).length,
      ).toBeGreaterThan(0);
    },
  );

  // Missing docs must fail in a test, not abort test-file collection.
  const examples = existsSync(specUrl)
    ? snippets(readFileSync(specUrl, 'utf8'))
    : [];
  it.each(
    examples.length
      ? examples
      : [
          {
            language: 'missing',
            outcome: 'SPEC.md',
            code: undefined,
            source: '',
            line: 1,
          },
        ],
  )(
    'checks $language $outcome $code at SPEC.md:$line against checkPack',
    snippet => {
      readSpec();
      const result = checkPack(packWith(snippet.language, snippet.source));
      const context = `SPEC.md:${snippet.line}: ${JSON.stringify(result.issues)}`;
      if (snippet.outcome === 'pack-ok') {
        expect(result.ok, context).toBe(true);
        expect(result.issues, context).toEqual([]);
      } else {
        expect(result.ok, context).toBe(false);
        expect(
          result.issues.map(issue => issue.code),
          context,
        ).toContain(snippet.code);
      }
    },
  );

  it('catches missing, invented or duplicate documented block types when the contract changes', () => {
    const documented = tableEntries(readSpec(), 'Block types');
    expect(documented.length).toBe(new Set(documented).size);
    expect([...documented].sort()).toEqual([...blockTypes].sort());
  });

  it('catches missing, invented or duplicate data-gt attributes in the author reference', () => {
    const documented = tableEntries(readSpec(), 'Attributes');
    expect(documented.length).toBe(new Set(documented).size);
    expect([...documented].sort()).toEqual([...attributes].sort());
  });

  it('rejects an undocumented data-gt attribute on an otherwise valid marked element', () => {
    const attribute = 'data-gt-unknown-spec-probe';
    const result = checkPack(
      packWith(
        'html',
        `<p data-gt="paragraph" ${attribute}="probe">{{summary}}</p>`,
      ),
    );
    expect(result.ok, JSON.stringify(result.issues)).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('gt-attribute');
  });

  it('catches broken relative repository links before pack authors follow them', () => {
    const markdown = readSpec();
    for (const match of markdown.matchAll(
      /\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g,
    )) {
      const target = match[1] ?? match[2] ?? '';
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
      const resolved = new URL(target, specUrl);
      const path = fileURLToPath(resolved);
      expect(
        existsSync(path),
        `SPEC.md link ${target} must resolve to a repository file`,
      ).toBe(true);
      expect(
        statSync(path).isFile(),
        `SPEC.md link ${target} must target a file`,
      ).toBe(true);
    }
  });
});
