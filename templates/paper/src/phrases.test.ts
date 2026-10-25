import { readFileSync } from 'node:fs';
import { type RuleField, rulesSchema } from '@pdf-generator/contract';
import { generate, recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';

const rules = rulesSchema.parse(
  JSON.parse(
    readFileSync(new URL('../pack/data/rules.json', import.meta.url), 'utf8'),
  ),
);
const schema = recordSchema(rules);

function checkText(
  rule: Extract<RuleField, { type: 'text' }>,
  value: unknown,
  path: string,
) {
  const phrases = rule.phrases;
  expect(phrases, `${path}: missing domain phrases`).toBeDefined();
  if (!phrases) throw new Error(`${path}: missing domain phrases`);
  expect(phrases.length, `${path}: empty domain phrases`).toBeGreaterThan(0);
  if (path === 'abstractEn') expect(rule.lang, path).toBe('en');
  const english = rule.lang === 'en';
  for (const phrase of phrases) {
    // Embedded marks would make phrase boundaries ambiguous to this oracle.
    expect(phrase, `${path}: phrase contains a joining mark`).not.toMatch(
      english ? /\./u : /[，；。]/u,
    );
  }
  expect(typeof value, path).toBe('string');
  if (typeof value !== 'string') throw new Error(`${path}: expected text`);
  expect(value.length, `${path}: empty generated paragraph`).toBeGreaterThan(0);

  // Capture separators so commas inside English phrases remain ordinary text.
  const parts = value.split(english ? /(\. ?)/u : /([，；。])/u);
  const endsWithMark = parts.at(-1) === '';
  if (endsWithMark) {
    expect(parts.at(-2), `${path}: wrong end mark`).toBe(english ? '.' : '。');
    parts.pop();
    parts.pop();
  }
  for (let index = 0; index < parts.length; index += 2) {
    const segment = parts[index] ?? '';
    const last = index === parts.length - 1;
    expect(segment.length, `${path}: empty phrase segment`).toBeGreaterThan(0);
    if (last) {
      // SPEC permits a final phrase prefix, including the no-end-mark cases.
      expect(
        phrases.some(phrase => phrase.startsWith(segment)),
        `${path}: final segment is not a prefix of its own phrases: ${segment}`,
      ).toBe(true);
    } else {
      expect(
        phrases,
        `${path}: foreign or truncated interior phrase`,
      ).toContain(segment);
      if (english) {
        const mark = parts[index + 1];
        // The documented dead end can leave one last character after a dot
        // with no room for the usual space; normal boundaries use '. '.
        if (mark === '.' && !endsWithMark && index === parts.length - 3) {
          expect(Array.from(parts[index + 2] ?? ''), path).toHaveLength(1);
        } else {
          expect(mark, `${path}: English phrase separator`).toBe('. ');
        }
      }
    }
  }
}

function checkField(rule: RuleField, value: unknown, path: string) {
  if (rule.type === 'text') checkText(rule, value, path);
  if (rule.type === 'array') {
    expect(Array.isArray(value), path).toBe(true);
    if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
    for (const [index, item] of value.entries()) {
      checkField(rule.items, item, `${path}[${index}]`);
    }
  }
  if (rule.type === 'object') {
    expect(value, path).toBeTypeOf('object');
    if (value === null || typeof value !== 'object')
      throw new Error(`${path}: expected an object`);
    for (const [name, field] of Object.entries(rule.fields)) {
      checkField(
        field,
        (value as Record<string, unknown>)[name],
        `${path}.${name}`,
      );
    }
  }
}

describe('paper domain phrases', () => {
  it.each(Array.from({ length: 20 }, (_, index) => `t27-paper-${index}`))(
    'uses each text field’s own phrases instead of default or other-section filler (%s)',
    seed => {
      // Regression: omitting phrases from even a nested item reintroduces
      // business filler; using another section's pool silently changes content.
      // Keep only this seed's record alive, rather than caching full records.
      const record = generate(rules, seed);
      expect(schema.safeParse(record).success, seed).toBe(true);
      for (const [name, field] of Object.entries(rules.fields)) {
        checkField(field, record[name], name);
      }
    },
  );
});
