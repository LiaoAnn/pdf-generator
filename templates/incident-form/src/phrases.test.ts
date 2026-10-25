import { readFileSync } from 'node:fs';
import { type RuleField, rulesSchema } from '@pdf-generator/contract';
import {
  type FakeValue,
  generate,
  recordSchema,
} from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';

const read = (file: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../pack/data/${file}`, import.meta.url), 'utf8'),
  );
const rules = rulesSchema.parse(read('rules.json'));
const schema = recordSchema(rules);

function expectPhraseText(
  rule: RuleField,
  value: FakeValue,
  path: string,
): void {
  if (rule.type === 'object') {
    if (value === null) return;
    if (typeof value !== 'object' || Array.isArray(value))
      throw new Error(`Expected object at ${path}`);
    for (const [key, child] of Object.entries(rule.fields)) {
      expectPhraseText(child, value[key] ?? null, `${path}.${key}`);
    }
    return;
  }
  if (rule.type === 'array') {
    if (value === null) return;
    if (!Array.isArray(value)) throw new Error(`Expected array at ${path}`);
    value.forEach((item, index) => {
      expectPhraseText(rule.items, item, `${path}[${index}]`);
    });
    return;
  }
  if (rule.type !== 'text') return;

  // Check even null fields: removing phrases must not silently restore the
  // built-in business wording when a blank field is populated in another seed.
  expect(rule.phrases, `${path}: missing phrases`).toBeDefined();
  const phrases = rule.phrases;
  if (!phrases) throw new Error(`Missing phrases at ${path}`);
  expect(phrases.length, path).toBeGreaterThan(0);
  expect(rule.lang, path).toBe('zh');
  for (const phrase of phrases) {
    // This pack property makes the segmentation below unambiguous.
    expect(phrase, `${path}: punctuation inside phrase`).not.toMatch(
      /[，；。]/u,
    );
  }
  if (value === null) return;
  if (typeof value !== 'string') throw new Error(`Expected text at ${path}`);

  const segments = value.split(/[，；。]/u);
  const endsWithMark = value.endsWith('。');
  if (endsWithMark) segments.pop();
  const tail = segments.pop();
  expect(tail, `${path}: empty final phrase`).toBeTruthy();
  expect(
    phrases.some(phrase => tail !== undefined && phrase.startsWith(tail)),
    `${path}: final segment ${JSON.stringify(tail)} is not a phrase prefix`,
  ).toBe(true);
  for (const segment of segments) {
    expect(
      phrases,
      `${path}: foreign segment ${JSON.stringify(segment)}`,
    ).toContain(segment);
  }
  if (!endsWithMark) {
    // SPEC exceptions: a single character, or a dead end with equally long
    // phrases, a whole phrase plus a mark, and one final phrase character.
    expect(Array.from(tail ?? ''), `${path}: unmarked tail`).toHaveLength(1);
    if (segments.length > 0) {
      const lastWhole = segments.at(-1) ?? '';
      for (const phrase of phrases) {
        expect(Array.from(phrase), `${path}: invalid dead end`).toHaveLength(
          Array.from(lastWhole).length,
        );
      }
    } else {
      expect(Array.from(value), `${path}: missing end mark`).toHaveLength(1);
    }
  }
}

function expectRecordPhrases(value: unknown, context: string) {
  const record = schema.parse(value);
  for (const [key, rule] of Object.entries(rules.fields)) {
    expectPhraseText(rule, record[key] ?? null, `${context}: ${key}`);
  }
}

describe('incident-form domain phrases', () => {
  it('prevents generated free text from falling back to business filler or another field’s phrases across 20 seeds', () => {
    for (let index = 0; index < 20; index++) {
      const seed = `t27-incident-phrases-${index}`;
      expectRecordPhrases(generate(rules, seed), seed);
    }
  });

  it('prevents preview text from drifting outside the phrases its field can generate', () => {
    expectRecordPhrases(read('sample.json'), 'preview');
  });
});
