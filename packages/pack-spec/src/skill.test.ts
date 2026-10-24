import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkPack } from '@pdf-generator/template-tools';
import { describe, expect, it } from 'vitest';
import { packWith, snippets } from './spec-fixtures.ts';

const repoUrl = new URL('../../../', import.meta.url);
const skillUrl = new URL('../skill/', import.meta.url);
const entryUrl = new URL('SKILL.md', skillUrl);
const referencesUrl = new URL('references/', skillUrl);

function readEntry(): string {
  expect(
    existsSync(entryUrl),
    'missing SKILL.md in packages/pack-spec/skill/',
  ).toBe(true);
  return readFileSync(entryUrl, 'utf8');
}

function referenceNames(): string[] {
  expect(
    existsSync(referencesUrl),
    'missing references/ in packages/pack-spec/skill/',
  ).toBe(true);
  const names = readdirSync(referencesUrl)
    .filter(name => name.endsWith('.md'))
    .sort();
  expect(
    names.length,
    'missing references/*.md in packages/pack-spec/skill/',
  ).toBeGreaterThan(0);
  return names;
}

function documents(): { url: URL; markdown: string }[] {
  const entry = { url: entryUrl, markdown: readEntry() };
  return [
    entry,
    ...referenceNames().map(name => {
      const url = new URL(name, referencesUrl);
      return { url, markdown: readFileSync(url, 'utf8') };
    }),
  ];
}

function relativeLinks(markdown: string, source: URL): URL[] {
  return [
    ...markdown.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g),
  ].flatMap(match => {
    const target = match[1] ?? match[2] ?? '';
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) return [];
    return [new URL(target, source)];
  });
}

function firstColumnCodes(markdown: string): string[] {
  return markdown.split(/\r?\n/).flatMap(line => {
    const column = /^\s*\|([^|]+)\|/.exec(line)?.[1];
    return column
      ? [...column.matchAll(/`([^`]+)`/g)].map(match => match[1] ?? '')
      : [];
  });
}

describe('template-pack skill stays usable by pack authors', () => {
  it('catches frontmatter that prevents Claude Code from discovering the skill', () => {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
      readEntry(),
    )?.[1];
    expect(
      frontmatter,
      'SKILL.md must start with YAML frontmatter',
    ).toBeDefined();
    const scalar = (key: string) => {
      const value = new RegExp(`^${key}: [\\t ]*(.+)$`, 'm')
        .exec(frontmatter ?? '')?.[1]
        ?.trim();
      return value?.replace(/^(['"])(.*)\1$/, '$2');
    };
    expect(scalar('name')).toBe('write-template-pack');
    expect(scalar('name')).toMatch(/^[a-z0-9-]+$/);
    const description = scalar('description');
    expect(
      description,
      'description must be a non-empty YAML scalar line',
    ).toBeTruthy();
    expect(description).not.toMatch(/^(?:[|>]|#|null$|~$)/);
    expect(description?.length).toBeLessThanOrEqual(1024);
  });

  it('catches examples that teach packs rejected by checkPack or mislabel an error code', () => {
    const examples = documents().flatMap(({ url, markdown }) =>
      snippets(markdown).map(snippet => ({ ...snippet, url })),
    );
    expect(
      examples.length,
      'the skill must contain at least one executable pack snippet',
    ).toBeGreaterThan(0);
    for (const snippet of examples) {
      const result = checkPack(packWith(snippet.language, snippet.source));
      const context = `${fileURLToPath(snippet.url)}:${snippet.line}: ${JSON.stringify(result.issues)}`;
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
    }
  });

  it('catches repository paths and relative links that strand authors at missing files', () => {
    for (const { url, markdown } of documents()) {
      for (const match of markdown.matchAll(
        /\$PDF_GENERATOR_REPO\/([^\s`"'<>()[\]{};,]+)/g,
      )) {
        const path = match[1] ?? '';
        const target = new URL(path, repoUrl);
        expect(
          target.href.startsWith(repoUrl.href),
          `${url.pathname}: repository path escapes the repo: ${path}`,
        ).toBe(true);
        expect(
          existsSync(target),
          `${url.pathname}: missing $PDF_GENERATOR_REPO/${path}`,
        ).toBe(true);
      }
      for (const target of relativeLinks(markdown, url)) {
        expect(
          target.href.startsWith(skillUrl.href),
          `${url.pathname}: relative link escapes the skill: ${target.pathname}`,
        ).toBe(true);
        expect(
          existsSync(target),
          `${url.pathname}: missing linked file ${target.pathname}`,
        ).toBe(true);
        expect(
          statSync(target).isFile(),
          `${target.pathname} must be a file`,
        ).toBe(true);
      }
    }
  });

  it('catches missing, invented or duplicate repair codes when SPEC.md checking codes change', () => {
    readEntry();
    referenceNames();
    const codesUrl = new URL('check-codes.md', referencesUrl);
    expect(existsSync(codesUrl), 'missing references/check-codes.md').toBe(
      true,
    );
    const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
    const section =
      /^## 9\. Checking a pack\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(
        spec,
      )?.[1];
    expect(section, 'SPEC.md must contain §9 Checking a pack').toBeDefined();
    const expected = firstColumnCodes(section ?? '');
    expect(
      expected.length,
      'SPEC.md §9 must list checker codes',
    ).toBeGreaterThan(0);
    const documented = firstColumnCodes(readFileSync(codesUrl, 'utf8'));
    expect(documented.length, 'repair codes must not be duplicated').toBe(
      new Set(documented).size,
    );
    expect([...documented].sort()).toEqual([...expected].sort());
  });

  it('catches reference files the agent cannot discover from SKILL.md', () => {
    const links = relativeLinks(readEntry(), entryUrl).map(url => {
      url.hash = '';
      url.search = '';
      return url.href;
    });
    for (const name of referenceNames()) {
      expect(links, `SKILL.md must link references/${name}`).toContain(
        new URL(name, referencesUrl).href,
      );
    }
  });
});
