import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generate } from './index.ts';

type Language = 'zh' | 'en' | 'mixed';
const languages: Language[] = ['zh', 'en', 'mixed'];
const seeds = Array.from({ length: 20 }, (_, i) => `phrases-${i}`);
const text = (lang: Language, minLength: number, maxLength = minLength) => ({
  type: 'text',
  lang,
  minLength,
  maxLength,
});
const rulesFor = (field: unknown) => ({
  schemaVersion: 1,
  fields: { body: field },
});
const phraseRules = (lang: Language, phrases: string[], length: number) =>
  rulesFor({ ...text(lang, length), phrases });
const diversitySeeds = Array.from({ length: 24 }, (_, i) => `diversity-${i}`);
const diversePhrases = (lang: Language) =>
  Array.from({ length: 26 }, (_, i) => {
    // Unique first code points make even a one-character tail attributable.
    const initial = String.fromCodePoint((lang === 'en' ? 65 : 0x4e00) + i);
    if (lang === 'en')
      return `${initial} team ${'verified '.repeat(1 + (i % 4))}records`;
    if (lang === 'mixed')
      return `${initial} API 現場紀錄已完成${'核對'.repeat(i % 5)}`;
    return `${initial}現場人員已完成紀錄核對${'確認'.repeat(i % 5)}`;
  });

function phraseSegments(body: string, lang: Language): string[] {
  const end = lang === 'en' ? '.' : '。';
  return (body.endsWith(end) ? body.slice(0, -1) : body).split(
    lang === 'en' ? /\. ?/u : /[，；。]/u,
  );
}

function stringValue(value: unknown): string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string') throw new Error('Expected text');
  return value;
}

// An independent grammar oracle: intermediate segments must be whole phrases;
// only the final segment may be a prefix. These phrases contain no marks.
function assertVocabulary(value: unknown, lang: Language, phrases: string[]) {
  const body = stringValue(value);
  const end = lang === 'en' ? '.' : '。';
  const hasEnd = body.endsWith(end);
  // English dead ends can omit the space before the last single character.
  const segments = phraseSegments(body, lang);
  const last = segments.pop();
  // A one-code-point remainder cannot hold a phrase head plus an end mark.
  if (!hasEnd) expect(Array.from(last ?? '')).toHaveLength(1);
  for (const segment of segments) expect(phrases).toContain(segment);
  expect(last).toBeTruthy();
  expect(phrases.some(phrase => phrase.startsWith(last ?? ''))).toBe(true);
}

describe('pack-supplied text phrases through the public engine', () => {
  it.each(languages)(
    'does not reuse whole %s phrases while a large pool remains unused',
    lang => {
      const phrases = diversePhrases(lang);
      for (const length of [1, 2, 12, 31, 80, 137, 200]) {
        const rules = phraseRules(lang, phrases, length);
        for (const seed of diversitySeeds) {
          const record = generate(rules, seed);
          const body = stringValue(record.body);
          const context = `${lang}, length ${length}, seed ${seed}: ${body}`;
          expect(generate(rules, seed), context).toEqual(record);
          expect(Array.from(body), context).toHaveLength(length);
          assertVocabulary(body, lang, phrases);
          const whole = phraseSegments(body, lang).filter(segment =>
            phrases.includes(segment),
          );
          expect(new Set(whole).size, context).toBe(whole.length);
        }
      }
    },
  );

  it.each(languages)(
    'takes the final %s phrase head from an unused phrase when one is long enough',
    lang => {
      const phrases = diversePhrases(lang);
      for (const length of [31, 80, 137, 200]) {
        for (const seed of diversitySeeds) {
          const body = stringValue(
            generate(phraseRules(lang, phrases, length), seed).body,
          );
          const segments = phraseSegments(body, lang);
          const tail = segments.pop() ?? '';
          const used = new Set(segments);
          const unused = phrases.filter(phrase => !used.has(phrase));
          if (
            unused.some(
              phrase => Array.from(phrase).length >= Array.from(tail).length,
            )
          ) {
            expect(
              unused.some(phrase => phrase.startsWith(tail)),
              `${lang}, length ${length}, seed ${seed}: reused tail ${tail} in ${body}`,
            ).toBe(true);
          }
        }
      }
    },
  );

  it.each(languages)(
    'exhausts fitting %s phrases before repeating and still fills 80 code points with a tiny pool',
    lang => {
      const phrases =
        lang === 'en'
          ? ['Ash', 'Elm']
          : lang === 'mixed'
            ? ['甲AB', '乙CD']
            : ['甲乙丙', '丁戊己'];
      const rules = phraseRules(lang, phrases, 80);
      for (const seed of diversitySeeds) {
        const record = generate(rules, seed);
        const body = stringValue(record.body);
        const context = `${lang}, seed ${seed}: ${body}`;
        expect(generate(rules, seed), context).toEqual(record);
        expect(Array.from(body), context).toHaveLength(80);
        assertVocabulary(body, lang, phrases);
        const seen = new Set<string>();
        let repeats = 0;
        for (const segment of phraseSegments(body, lang)) {
          if (!phrases.includes(segment)) continue;
          if (seen.has(segment)) {
            expect(seen.size, context).toBe(phrases.length);
            repeats++;
          }
          seen.add(segment);
        }
        expect(repeats, context).toBeGreaterThan(0);
      }
    },
  );

  it.each(languages)(
    'CLI swaps %s domain vocabulary, honours bounds in arrays and replays the same seed',
    lang => {
      const vocabularies =
        lang === 'en'
          ? [
              ['Fire crews arrived', 'Smoke cleared'],
              ['Cells divided', 'Samples cooled'],
            ]
          : [
              ['消防人員抵達', '現場濃煙散去'],
              ['細胞分裂完成', '樣本冷卻完畢'],
            ];
      const script = `
      import { readFileSync } from 'node:fs';
      import { generate } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const { rules, seeds } = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(seeds.map(seed => generate(rules, seed))));
    `;
      const outputs = vocabularies.map(phrases => {
        const field = { ...text(lang, 30, 80), phrases };
        const rules = {
          schemaVersion: 1,
          fields: {
            body: field,
            rows: { type: 'array', minItems: 2, maxItems: 2, items: field },
          },
        };
        const run = () =>
          execFileSync(
            process.execPath,
            ['--input-type=module', '--eval', script],
            {
              input: JSON.stringify({ rules, seeds: seeds.slice(0, 6) }),
              encoding: 'utf8',
              timeout: 10_000,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
        const bytes = run();
        expect(run()).toBe(bytes);
        const records: { body: unknown; rows: unknown[] }[] = JSON.parse(bytes);
        for (const record of records) {
          expect(record.rows).toHaveLength(2);
          for (const value of [record.body, ...record.rows]) {
            const length = Array.from(stringValue(value)).length;
            expect(length).toBeGreaterThanOrEqual(30);
            expect(length).toBeLessThanOrEqual(80);
            assertVocabulary(value, lang, phrases);
          }
        }
        return bytes;
      });
      expect(outputs[0]).not.toBe(outputs[1]);
    },
  );

  it('preserves pinned JSON bytes for built-in zh, en and mixed text, including array items', () => {
    // Re-pinned for the intentional T05-2 random-stream change.
    // Pack-supplied phrase changes must leave these no-phrases cases unchanged.
    const hash = createHash('sha256');
    for (const lang of languages) {
      const rules = {
        schemaVersion: 1,
        fields: {
          tiny: text(lang, 1),
          short: text(lang, 2, 12),
          long: text(lang, 200, 400),
          rows: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: text(lang, 5, 80),
          },
        },
      };
      for (const seed of ['legacy-a', 'legacy-b', 'legacy-c', 'legacy-d']) {
        hash.update(JSON.stringify(generate(rules, seed)));
      }
    }
    expect(hash.digest('hex')).toBe(
      'd8faa13c8c1d5918061326eda47e5ead8b3091d01879d1507114c7bce924ae61',
    );
  });

  it.each(languages)(
    'keeps the drawn %s length when phrases replace built-in filler',
    lang => {
      const field = text(lang, 1, 80);
      for (const seed of seeds) {
        const expectedLength = Array.from(
          stringValue(generate(rulesFor(field), seed).body),
        ).length;
        const actual = generate(
          rulesFor({ ...field, phrases: ['甲乙丙', 'ABCDE', '𠮷野家'] }),
          seed,
        );
        expect(Array.from(stringValue(actual.body))).toHaveLength(
          expectedLength,
        );
      }
    },
  );

  it.each(languages)(
    'cuts an overlong %s phrase to a head plus end mark',
    lang => {
      const phrase = '這是一個很長很長的句子';
      for (const seed of seeds.slice(0, 3)) {
        expect(generate(phraseRules(lang, [phrase], 5), seed).body).toBe(
          `這是一個${lang === 'en' ? '.' : '。'}`,
        );
      }
    },
  );

  it.each([
    ['zh', ['甲乙丙'], 4, '甲乙丙。'],
    ['mixed', ['甲乙丙'], 4, '甲乙丙。'],
    ['en', ['ABC'], 9, 'ABC. ABC.'],
  ] as const)(
    'retains whole %s phrases when they fit exactly',
    (lang, phrases, length, expected) => {
      expect(
        generate(phraseRules(lang, [...phrases], length), 'exact-fit').body,
      ).toBe(expected);
    },
  );

  it.each(languages)(
    'uses the first code point without a mark for length-one %s text',
    lang => {
      expect(
        generate(phraseRules(lang, ['𠮷野家'], 1), 'one-character').body,
      ).toBe('𠮷');
    },
  );

  it.each(['zh', 'mixed'] as const)(
    'fills the %s dead end with an unmarked phrase head',
    lang => {
      for (const seed of seeds) {
        const value = stringValue(
          generate(phraseRules(lang, ['甲乙丙'], 5), seed).body,
        );
        expect(value).toMatch(/^甲乙丙[，；。]甲$/u);
        expect(Array.from(value)).toHaveLength(5);
      }
    },
  );

  it.each(languages)(
    'counts astral characters as one and never emits a split surrogate in %s text',
    lang => {
      for (const length of [2, 3, 4, 7, 12, 40]) {
        const value = stringValue(
          generate(phraseRules(lang, ['𠮷野家'], length), 'astral-length').body,
        );
        expect(Array.from(value)).toHaveLength(length);
        expect(value.isWellFormed()).toBe(true);
        // Each Han character is allowed, but a dangling half-surrogate is not.
        expect(value).toMatch(
          lang === 'en' ? /^[𠮷野家. ]+$/u : /^[𠮷野家，；。]+$/u,
        );
        if (length === 2) expect(value).toBe(`𠮷${lang === 'en' ? '.' : '。'}`);
        if (length === 4)
          expect(value).toBe(`𠮷野家${lang === 'en' ? '.' : '。'}`);
      }
    },
  );

  it('keeps phrase blanks nullable without shifting the nonblank seed stream', () => {
    const field = {
      ...text('zh', 30, 80),
      phrases: ['消防人員抵達', '現場濃煙散去'],
    };
    let blanks = 0;
    let nonblanks = 0;
    for (const seed of seeds) {
      const original = generate(rulesFor(field), seed);
      expect(
        generate(rulesFor({ ...field, blankProbability: 0 }), seed),
      ).toEqual(original);
      expect(
        generate(rulesFor({ ...field, blankProbability: 1 }), seed),
      ).toEqual({ body: null });
      const rules = rulesFor({ ...field, blankProbability: 0.5 });
      const record = generate(rules, seed);
      expect(generate(rules, seed)).toEqual(record);
      if (record.body === null) blanks++;
      else {
        nonblanks++;
        expect(record).toEqual(original);
        assertVocabulary(record.body, 'zh', field.phrases);
      }
    }
    expect(blanks).toBeGreaterThan(0);
    expect(nonblanks).toBeGreaterThan(0);
  });
});
