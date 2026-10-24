import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RuleField, Rules } from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { generate, recordSchema } from './index.ts';

type Language = Extract<RuleField, { type: 'text' }>['lang'];
const languages: Language[] = ['zh', 'en', 'mixed'];
const seeds = Array.from({ length: 100 }, (_, index) =>
  createHash('sha256').update(`T12-text-batch\n${index}`).digest('hex'),
);
const textField = (
  lang: Language,
  minLength: number,
  maxLength = minLength,
): RuleField => ({ type: 'text', lang, minLength, maxLength });
const oneField = (value: RuleField): Rules => ({
  schemaVersion: 1,
  fields: { value },
});

function assertText(
  value: unknown,
  lang: Language,
  minLength: number,
  maxLength = minLength,
): asserts value is string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string') throw new Error('Expected filler text');
  const length = [...value].length;
  expect(length).toBeGreaterThanOrEqual(minLength);
  expect(length).toBeLessThanOrEqual(maxLength);
  expect(value).not.toMatch(/^ | $| {2}/);
  if (lang === 'en') {
    expect(value).toMatch(/^[A-Z][A-Za-z .,]*$/);
    expect(value).not.toMatch(/ [.,]/);
    if (length >= 2) expect(value.endsWith('.')).toBe(true);
  } else {
    expect(value).toMatch(
      lang === 'zh'
        ? /^[\p{Script=Han}，。、；：！？]+$/u
        : /^[\p{Script=Han}A-Za-z0-9 %.，。、；：！？]+$/u,
    );
    // Simplified-only forms; shared characters such as 件 remain valid Chinese.
    expect(value).not.toMatch(/[们这个发对时说国会为来实现经资讯网络软质项]/u);
    expect(value).not.toMatch(/ [，。、；：！？]|[，。、；：！？] /u);
    if (lang === 'zh') {
      expect(value).toMatch(/^\p{Script=Han}/u);
      expect(value).not.toMatch(/[，。、；：！？]{2}/u);
    }
    if (length >= 2) expect(value.endsWith('。')).toBe(true);
    if (lang === 'mixed' && length >= 12) {
      expect(value).toMatch(/\p{Script=Han}/u);
      expect(value).toMatch(/[A-Za-z0-9]/);
    }
  }
  if (length === 1) {
    expect(value).toMatch(lang === 'en' ? /^[A-Za-z]$/ : /^\p{Script=Han}$/u);
  }
}

describe('document filler text through the public engine', () => {
  it.each(languages)(
    'CLI replays 100 varied %s batch fixtures with valid language, punctuation and every short length',
    lang => {
      const rules: Rules = {
        schemaVersion: 1,
        fields: {
          remark: textField(lang, 5, 12),
          memo: textField(lang, 12, 80),
          body: textField(lang, 200, 400),
        },
      };
      // Exercise Node's real package entry point, independently of Vitest's loader.
      const script = `
        import { readFileSync } from 'node:fs';
        import { createHash } from 'node:crypto';
        import { generate, recordSchema } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
        const rules = JSON.parse(readFileSync(0, 'utf8'));
        const schema = recordSchema(rules);
        const records = Array.from({ length: 100 }, (_, index) => {
          const seed = createHash('sha256').update('T12-text-batch\\n' + index).digest('hex');
          return schema.parse(generate(rules, seed));
        });
        process.stdout.write(JSON.stringify(records));
      `;
      const run = () =>
        execFileSync(
          process.execPath,
          ['--input-type=module', '--eval', script],
          {
            input: JSON.stringify(rules),
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      const bytes = run();
      expect(run()).toBe(bytes);
      const records: Record<string, unknown>[] = JSON.parse(bytes);
      expect(records).toHaveLength(100);
      const lengths = new Set<number>();
      const texts = new Set<string>();
      const words = new Set<string>();
      let corpus = '';
      const schema = recordSchema(rules);
      for (const record of records) {
        expect(schema.parse(record)).toEqual(record);
        assertText(record.remark, lang, 5, 12);
        assertText(record.memo, lang, 12, 80);
        assertText(record.body, lang, 200, 400);
        lengths.add([...record.remark].length);
        texts.add(record.body);
        corpus += record.body;
        if (lang === 'en') {
          for (const token of record.body.split(' ')) {
            const word = token.replace(/[.,]/g, '').toLowerCase();
            expect(word).toMatch(/^[a-z]+$/);
            // Detect arbitrary single-letter fragments left by truncation.
            if (word.length === 1) expect(['a', 'i']).toContain(word);
            words.add(word);
          }
        }
      }
      expect(lengths).toEqual(new Set([5, 6, 7, 8, 9, 10, 11, 12]));
      expect(texts.size).toBeGreaterThan(1);
      if (lang === 'en') expect(words.size).toBeGreaterThanOrEqual(20);
      if (lang === 'mixed') {
        expect(corpus).toMatch(/[A-Za-z]/);
        expect(corpus).toMatch(/[0-9]/);
        // A number followed by a unit or percent, without fixing the term list.
        expect(corpus).toMatch(/\d(?:\.\d+)? ?(?:[A-Za-z]+|%)/);
      }
    },
  );

  it.each(languages)(
    'keeps exact %s lengths 1 through 12 printable without broken endings or spacing',
    lang => {
      for (let length = 1; length <= 12; length++) {
        const rules = oneField(textField(lang, length));
        for (const seed of seeds.slice(0, 20)) {
          const record = generate(rules, seed);
          assertText(record.value, lang, length);
          expect(recordSchema(rules).parse(record)).toEqual(record);
        }
      }
    },
  );

  it.each(languages)(
    'fills a 5000-character %s paragraph within the normal test timeout',
    lang => {
      const rules = oneField(textField(lang, 5000));
      for (const seed of seeds.slice(0, 3)) {
        const record = generate(rules, seed);
        assertText(record.value, lang, 5000);
        expect(recordSchema(rules).parse(record)).toEqual(record);
      }
    },
  );

  it.each(languages)(
    'applies %s text blanks at both endpoints and preserves nonblank replay under partial blanking',
    lang => {
      const field = textField(lang, 30, 80);
      const baseline = oneField(field);
      const never = oneField({ ...field, blankProbability: 0 });
      const always = oneField({ ...field, blankProbability: 1 });
      const sometimes = oneField({ ...field, blankProbability: 0.3 });
      let blanks = 0;
      let nonblanks = 0;
      for (const seed of seeds) {
        const original = generate(baseline, seed);
        expect(generate(never, seed)).toEqual(original);
        const blank = generate(always, seed);
        expect(blank).toEqual({ value: null });
        expect(recordSchema(always).parse(blank)).toEqual(blank);
        const record = generate(sometimes, seed);
        expect(recordSchema(sometimes).parse(record)).toEqual(record);
        expect(generate(sometimes, seed)).toEqual(record);
        if (record.value === null) blanks++;
        else {
          nonblanks++;
          expect(record).toEqual(original);
          assertText(record.value, lang, 30, 80);
        }
      }
      expect(blanks).toBeGreaterThan(0);
      expect(nonblanks).toBeGreaterThan(0);
    },
  );
});
