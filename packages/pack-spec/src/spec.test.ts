import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blockTypes, jsonSchemas } from '@pdf-generator/contract';
import { checkPack } from '@pdf-generator/template-tools';
import { describe, expect, it } from 'vitest';

import { packWith, snippets } from './spec-fixtures.ts';

const specUrl = new URL('../SPEC.md', import.meta.url);
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

interface SpecTable {
  /** Section text before the table. */
  intro: string;
  /** Body rows (header and divider dropped), split into trimmed cells. */
  rows: string[][];
}

function sectionTable(markdown: string, heading: string): SpecTable {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === heading);
  expect(start, `SPEC.md must contain ${heading}`).toBeGreaterThanOrEqual(0);
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
  const rows: string[][] = [];
  for (const line of section.slice(tableStart + 2)) {
    if (!/^\s*\|/.test(line)) break;
    rows.push(
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map(cell => cell.trim()),
    );
  }
  return { intro: section.slice(0, tableStart).join('\n'), rows };
}

function tableEntries(markdown: string, heading: string): string[] {
  return sectionTable(markdown, `### ${heading}`).rows.flatMap(
    ([first = '']) => /^`([^`]+)`$/.exec(first)?.[1] ?? [],
  );
}

interface RuleVariant {
  properties: Record<string, unknown>;
  required: string[];
}

/** Every `RuleField` variant of the published rules contract, by `type`. */
function contractRuleVariants(): Map<string, RuleVariant> {
  const variants = jsonSchemas().rules?.$defs?.RuleField?.oneOf ?? [];
  expect(
    variants.length,
    'rules contract has RuleField variants',
  ).toBeGreaterThan(0);
  return new Map(
    variants.map(variant => {
      const typeSchema = variant.properties?.type;
      const type =
        typeof typeSchema === 'object' ? typeSchema.const : undefined;
      expect(typeof type, 'every RuleField variant has a const type').toBe(
        'string',
      );
      return [
        String(type),
        {
          properties: variant.properties ?? {},
          required: variant.required ?? [],
        },
      ];
    }),
  );
}

/**
 * The keys an "Extra keys" cell names: backticked names at the cell start or
 * after `, `, outside parentheses; a trailing `?` marks the key optional.
 * Values (`male` \| `female`, `YYYY-MM-DD`) follow `: ` or `| ` instead.
 */
function documentedKeys(cell: string): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  const outside = cell.replace(/\([^)]*\)/g, '');
  for (const match of outside.matchAll(/(?:^|, )`([A-Za-z]+)(\??)`/g)) {
    const [, key = '', optional] = match;
    expect(keys.has(key), `key ${key} listed twice in ${cell}`).toBe(false);
    keys.set(key, optional === '?');
  }
  return keys;
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

  it('catches rule types and keys the contract has but the rules.json table misses or invents', () => {
    const { intro, rows } = sectionTable(
      readSpec(),
      '## 2. Data: rules.json and sample.json',
    );
    const variants = contractRuleVariants();
    const documented = new Map<string, string>();
    for (const [typeCell = '', keysCell = ''] of rows) {
      const type = /^`([^`]+)`$/.exec(typeCell)?.[1] ?? typeCell;
      expect(documented.has(type), `rule type ${type} listed twice`).toBe(
        false,
      );
      documented.set(type, keysCell);
    }
    expect([...documented.keys()].sort()).toEqual([...variants.keys()].sort());

    // Keys every rule takes are described once, above the table.
    const shared = [...variants.values()]
      .map(variant => Object.keys(variant.properties))
      .reduce((all, keys) => all.filter(key => keys.includes(key)));
    for (const key of shared.filter(key => key !== 'type')) {
      expect(intro, `§2 must describe the shared key ${key}`).toContain(
        `\`${key}\``,
      );
    }

    for (const [type, variant] of variants) {
      const keys = documentedKeys(documented.get(type) ?? '');
      const expected = Object.keys(variant.properties)
        .filter(key => !shared.includes(key))
        .sort();
      expect([...keys.keys()].sort(), `keys of ${type}`).toEqual(expected);
      for (const key of expected) {
        expect(
          keys.get(key),
          `${type}.${key} is ${variant.required.includes(key) ? 'required: drop' : 'optional: add'} its ?`,
        ).toBe(!variant.required.includes(key));
      }
    }
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
