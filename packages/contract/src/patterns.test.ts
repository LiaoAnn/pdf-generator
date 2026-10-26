import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  gtSchema,
  jsonSchemas,
  manifestSchema,
  relativePathSchema,
  rulesSchema,
  seedSchema,
  slugSchema,
  templateSummarySchema,
} from './index.ts';

function example(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../examples/${name}.valid.json`, import.meta.url),
      'utf8',
    ),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) => [
      key,
      ...strings(child),
    ]);
  return [];
}

function patterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(patterns);
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    return [
      ...(typeof node.pattern === 'string' ? [node.pattern] : []),
      ...Object.values(node).flatMap(patterns),
    ];
  }
  return [];
}

const samples = readdirSync(new URL('../examples/', import.meta.url))
  .filter(file => file.endsWith('.valid.json'))
  .flatMap(file =>
    strings(
      JSON.parse(
        readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'),
      ),
    ),
  );
const exportedPatterns = [...new Set(patterns(jsonSchemas()))];
// These check for content anywhere in the string, not its ending.
const containmentPatterns = new Set([String.raw`\S`]);

test.each([
  ['rule date', '2026-01-01', '２０２６-01-01'],
  ['API timestamp', '2026-01-01T00:00:00Z', '２０２６-01-01T00:00:00Z'],
])(
  '%s rejects full-width digits in both zod and exported Python patterns',
  (label, valid, invalid) => {
    const schema = label === 'rule date' ? rulesSchema : templateSummarySchema;
    const input =
      label === 'rule date'
        ? {
            schemaVersion: 1,
            fields: { date: { type: 'date', min: invalid, max: '2026-12-31' } },
          }
        : { ...example('template-summary'), createdAt: invalid };
    expect.soft(schema.safeParse(input).success).toBe(false);
    const candidates = patterns(
      label === 'rule date'
        ? jsonSchemas().rules
        : jsonSchemas()['template-summary'],
    ).filter(
      pattern =>
        new RegExp(pattern, 'u').test(valid) &&
        !new RegExp(pattern, 'u').test('styles/base.css'),
    );
    expect(candidates.length).toBeGreaterThan(0);
    for (const pattern of candidates) {
      expect.soft(new RegExp(pattern, 'u').test(invalid), pattern).toBe(false);
      expect
        .soft(pythonMatches(pattern, invalid), pattern)
        .toEqual([false, false]);
    }
  },
);

test.each(['x\u2028/..', 'x\u2029/../y'])(
  'rejects traversal after a Unicode line separator in manifest path %j in JS and Python',
  value => {
    expect.soft(relativePathSchema.safeParse(value).success).toBe(false);
    const manifest = example('manifest');
    expect
      .soft(
        manifestSchema.safeParse({
          ...manifest,
          files: { ...(manifest.files as object), styles: [value] },
        }).success,
      )
      .toBe(false);
    const pathPatterns = [...new Set(patterns(jsonSchemas().manifest))].filter(
      pattern =>
        !containmentPatterns.has(pattern) &&
        new RegExp(pattern, 'u').test('styles/base.css'),
    );
    expect(pathPatterns.length).toBeGreaterThan(0);
    for (const pattern of pathPatterns) {
      expect.soft(new RegExp(pattern, 'u').test(value), pattern).toBe(false);
      expect
        .soft(pythonMatches(pattern, value), pattern)
        .toEqual([false, false]);
    }
  },
);

function pythonMatches(pattern: string, value: string): boolean[] {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,re,sys\np,v=json.load(sys.stdin)\nprint(json.dumps([bool(re.search(p,v)),bool(re.search(p,v+"\\n"))]))',
      ],
      { input: JSON.stringify([pattern, value]), encoding: 'utf8' },
    ),
  );
}

test.each(exportedPatterns)(
  'exported pattern %s contains no unescaped $ end anchor, including containment checks',
  pattern => {
    // An even number of preceding backslashes leaves the dollar unescaped.
    expect(pattern).not.toMatch(/(?<!\\)(?:\\\\)*\$/);
  },
);

test.each(
  exportedPatterns.filter(pattern => !containmentPatterns.has(pattern)),
)(
  'end-constraining exported pattern %s uses a true end anchor in JS and Python, including property names',
  pattern => {
    const value = samples.find(value => new RegExp(pattern).test(value));
    expect(value, `No valid example covers ${pattern}`).toBeDefined();
    if (value === undefined)
      throw new Error(`No valid example covers ${pattern}`);
    expect.soft(pythonMatches(pattern, value)).toEqual([true, false]);
    expect
      .soft([value, `${value}\n`].map(input => new RegExp(pattern).test(input)))
      .toEqual([true, false]);
    expect.soft(pattern.endsWith(String.raw`(?![\s\S])`)).toBe(true);
  },
);

test.each(exportedPatterns.filter(pattern => containmentPatterns.has(pattern)))(
  'containment exported pattern %s agrees in JS and Python with and without a trailing newline',
  pattern => {
    const value = samples.find(value => new RegExp(pattern).test(value));
    expect(value, `No valid example covers ${pattern}`).toBeDefined();
    if (value === undefined)
      throw new Error(`No valid example covers ${pattern}`);
    const jsMatches = [value, `${value}\n`].map(input =>
      new RegExp(pattern).test(input),
    );
    expect.soft(jsMatches).toEqual([true, true]);
    expect.soft(pythonMatches(pattern, value)).toEqual(jsMatches);
  },
);

test.each([
  ['slug', slugSchema, 'monthly-report'],
  ['seed', seedSchema, 'Seed_01-a'],
  ['relative path', relativePathSchema, 'styles/base.css'],
] as const)(
  '%s rejects a trailing newline in runtime consumers',
  (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse(`${value}\n`).success).toBe(false);
  },
);

test('manifest CSS paths, API timestamps, rule dates and gt block ids reject trailing newlines', () => {
  const manifest = example('manifest');
  const summary = example('template-summary');
  const gt = example('gt');
  const cases = [
    [
      manifestSchema,
      manifest,
      {
        ...manifest,
        files: { ...(manifest.files as object), styles: ['styles/base.css\n'] },
      },
    ],
    [
      templateSummarySchema,
      summary,
      { ...summary, createdAt: `${summary.createdAt}\n` },
    ],
    [
      rulesSchema,
      {
        schemaVersion: 1,
        fields: {
          date: { type: 'date', min: '2026-01-01', max: '2026-12-31' },
        },
      },
      {
        schemaVersion: 1,
        fields: {
          date: { type: 'date', min: '2026-01-01\n', max: '2026-12-31' },
        },
      },
    ],
    [
      gtSchema,
      gt,
      {
        ...gt,
        blocks: (gt.blocks as Record<string, unknown>[]).map((block, i) =>
          i === 0 ? { ...block, id: `${block.id}\n` } : block,
        ),
      },
    ],
  ] as const;
  for (const [schema, valid, invalid] of cases) {
    expect.soft(schema.safeParse(valid).success).toBe(true);
    expect.soft(schema.safeParse(invalid).success).toBe(false);
  }
});
