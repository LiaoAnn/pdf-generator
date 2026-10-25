import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate,
  isValidBusinessId,
  isValidNationalId,
} from '@pdf-generator/fake-data';
import { zipSync } from 'fflate';
import { create } from 'fontkit';
import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5';
import { describe, expect, it } from 'vitest';
import { checkPack, fill, type PackIssue } from './index.ts';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const broken = readdirSync(join(fixtures, 'broken')).sort();

function readPack(directory: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  function visit(relative: string) {
    for (const entry of readdirSync(join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else files[path] = readFileSync(join(directory, path));
    }
  }
  visit('');
  return files;
}

function textContent(html: string): string {
  const text: string[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ('value' in node) text.push(node.value);
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(html));
  return text.join('');
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object')
    return Object.values(value).map(valueText).join('');
  return String(value);
}

describe('committed template pack acceptance corpus', () => {
  it('retains exactly ten independently broken packs instead of losing acceptance cases', () => {
    expect(broken).toHaveLength(10);
    const valid = readPack(join(fixtures, 'valid'));
    for (const slug of broken) {
      const pack = readPack(join(fixtures, 'broken', slug, 'pack'));
      expect(Object.keys(pack).sort()).toEqual(Object.keys(valid).sort());
      const changed = Object.entries(valid).filter(
        ([file, bytes]) =>
          file !== 'assets/report.woff2' &&
          !Buffer.from(bytes).equals(Buffer.from(pack[file] ?? [])),
      );
      expect(changed, slug).toHaveLength(1);
    }
  });

  it('prevents placeholder, sample-only, or full-size fonts from breaking generated batch text', () => {
    const directory = join(fixtures, 'valid');
    const template = readFileSync(
      join(directory, 'templates/report.hbs'),
      'utf8',
    );
    const sample: unknown = JSON.parse(
      readFileSync(join(directory, 'data/sample.json'), 'utf8'),
    );
    const rules: unknown = JSON.parse(
      readFileSync(join(directory, 'data/rules.json'), 'utf8'),
    );
    const characters = new Set<string>();
    const add = (text: string) => {
      for (const character of text) {
        // Source line breaks and tabs are layout; printed spaces need a glyph.
        if (!/[\t\r\n]/u.test(character)) characters.add(character);
      }
    };
    // Keep literal text from both conditional branches, independently of data.
    add(textContent(template.replace(/{{[\s\S]*?}}/g, '')));
    add(valueText(sample));
    add(textContent(fill(template, sample)));
    add('／：');
    // Match the README's subset recipe directly: every non-ASCII source
    // character covers every generator word list, without relying on seeds
    // to happen to select every entry (and excludes test-only characters).
    const source = fileURLToPath(
      new URL('../../fake-data/src/', import.meta.url),
    );
    for (const directory of [source, join(source, 'taiwan')]) {
      for (const file of readdirSync(directory).sort()) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        for (const character of readFileSync(join(directory, file), 'utf8')) {
          if ((character.codePointAt(0) as number) > 0x7f) add(character);
        }
      }
    }
    // Number/date helpers add printable ASCII (commas, digits, separators).
    // Cover its entire range, then render sample + seed 0 to exercise fill;
    // avoid parsing and rendering the same template 2,500 times.
    for (let codePoint = 0x20; codePoint <= 0x7e; codePoint++) {
      add(String.fromCodePoint(codePoint));
    }
    // Retain the full deterministic batch; source coverage above guarantees
    // word-list coverage independently of this count or future list growth.
    for (let seed = 0; seed < 2500; seed++) {
      const record = generate(rules, `valid-pack-font-${seed}`);
      add(valueText(record));
      if (seed === 0) add(textContent(fill(template, record)));
    }

    const bytes = readFileSync(join(directory, 'assets/report.woff2'));
    expect(
      bytes.byteLength,
      'keep the reference pack font a small subset',
    ).toBeLessThan(250_000);
    const font = create(bytes);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
    if (!('hasGlyphForCodePoint' in font)) {
      throw new Error('report.woff2 must be a single font, not a collection');
    }
    expect(
      font.characterSet.length,
      'font must expose a populated cmap',
    ).toBeGreaterThan(0);
    const missing = [...characters].filter(
      character =>
        !font.hasGlyphForCodePoint(character.codePointAt(0) as number),
    );
    expect(missing, 'glyphs missing from the valid pack font').toEqual([]);
  }, 60_000);

  it('keeps the positive control usable as both directory bytes and zip bytes', () => {
    const files = readPack(join(fixtures, 'valid'));
    const sample = JSON.parse(
      new TextDecoder().decode(files['data/sample.json']),
    );
    expect(isValidNationalId(sample.nationalId)).toBe(true);
    expect(isValidBusinessId(sample.businessId)).toBe(true);
    for (const input of [files, zipSync(files)]) {
      const result = checkPack(input);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.pack?.manifest.id).toBe('taiwan-monthly-report');
    }
  });

  describe.each(broken)('%s', slug => {
    const directory = join(fixtures, 'broken', slug);
    const expected = JSON.parse(
      readFileSync(join(directory, 'expected.json'), 'utf8'),
    ) as { description: string; issues: Omit<PackIssue, 'message'>[] };

    it.each(['file map', 'zip'])(
      `catches ${expected.description} with exact source locations via %s`,
      format => {
        const files = readPack(join(directory, 'pack'));
        const result = checkPack(format === 'zip' ? zipSync(files) : files);
        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty('pack');
        expect(
          result.issues.map(({ message, ...issue }) => {
            expect(message.trim().length).toBeGreaterThan(0);
            return issue;
          }),
        ).toEqual(expected.issues);
      },
    );
  });
});
