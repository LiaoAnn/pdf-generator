import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { beforeEach, expect, test, vi } from 'vitest';

let createRng: typeof import('./random.ts').createRng;
beforeEach(async () => {
  ({ createRng } = await import('./random.ts'));
});

test('fresh CLI runs reproduce the pinned stream and distinguish seeds', () => {
  const run = (seed: string) => {
    const script = `
      import { createRng } from ${JSON.stringify(new URL('./random.ts', import.meta.url).href)};
      const rng = createRng(${JSON.stringify(seed)}, 'field');
      console.log(JSON.stringify(Array.from({ length: 8 }, () => rng.int(0, 1_000_000))));
    `;
    return execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  };
  const first = run('seed-1');
  expect(run('seed-1')).toBe(first);
  expect(run('seed-2')).not.toBe(first);
  expect(JSON.parse(first)).toMatchInlineSnapshot(`
    [
      35906,
      53000,
      673487,
      936386,
      279072,
      22045,
      478546,
      495813,
    ]
  `);
});

test('mixed calls replay independently of other streams and ambient randomness', () => {
  const forbidden = () => {
    throw new Error('generation must not use ambient randomness or time');
  };
  const random = vi.spyOn(Math, 'random').mockImplementation(forbidden);
  const now = vi.spyOn(Date, 'now').mockImplementation(forbidden);
  try {
    const left = createRng('', '欄位.😀');
    const right = createRng('', '欄位.😀');
    for (let i = 0; i < 30; i++) {
      expect(left.int(-100, 100)).toBe(right.int(-100, 100));
      createRng('unrelated', String(i)).int(0, 100);
      expect(left.pick(['甲', '乙', '丙'])).toBe(
        right.pick(['甲', '乙', '丙']),
      );
      expect(left.weighted(['a', 'b'], [1, 3])).toBe(
        right.weighted(['a', 'b'], [1, 3]),
      );
    }
  } finally {
    random.mockRestore();
    now.mockRestore();
  }
});

test('seed and path hashing preserves boundaries and small path differences', () => {
  const pairs = [
    ['seed-1', 'a'],
    ['seed-2', 'a'],
    ['seed-1', 'b'],
    ['seed-1', 'a.1'],
    ['seed-1', 'a.10'],
    ['ab', 'c'],
    ['a', 'bc'],
  ] as const;
  const streams = pairs.map(([seed, path]) => {
    const rng = createRng(seed, path);
    return JSON.stringify(
      Array.from({ length: 16 }, () => rng.int(0, 1_000_000)),
    );
  });
  expect(new Set(streams).size).toBe(pairs.length);
});

test('integer draws honor inclusive bounds without truncating wide ranges', () => {
  const rng = createRng('bounds', 'field');
  for (const [min, max] of [
    [7, 7],
    [-9, -1],
    [-3, 3],
    [0, Number.MAX_SAFE_INTEGER],
    [-Number.MAX_SAFE_INTEGER, 0],
  ] as const) {
    const values = Array.from({ length: 1_000 }, () => rng.int(min, max));
    expect(
      values.every(n => Number.isSafeInteger(n) && n >= min && n <= max),
    ).toBe(true);
    if (min === 0) expect(values.some(n => n > 2 ** 32)).toBe(true);
    else if (max === 0) expect(values.some(n => n < -(2 ** 32))).toBe(true);
    else
      expect(new Set(values)).toEqual(
        new Set(Array.from({ length: max - min + 1 }, (_, i) => min + i)),
      );
  }
});

test('integer sampling avoids collapsed or grossly biased buckets', () => {
  const rng = createRng('uniformity', 'field');
  const counts = Array<number>(10).fill(0);
  for (let i = 0; i < 20_000; i++) {
    const bucket = rng.int(0, 9);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  expect(counts.every(n => n > 1_600 && n < 2_400)).toBe(true);
});

test('pick reaches every item and returns the original item', () => {
  const rng = createRng('pick', 'field');
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }] as const;
  const picked = Array.from({ length: 300 }, () => rng.pick(items));
  expect(picked.every(item => items.includes(item))).toBe(true);
  expect(new Set(picked)).toEqual(new Set(items));
});

test('weighted selection excludes zero weights and follows relative proportions', () => {
  const rng = createRng('weighted', 'field');
  const counts = { zero: 0, one: 0, three: 0 };
  for (let i = 0; i < 20_000; i++)
    counts[rng.weighted(['zero', 'one', 'three'] as const, [0, 1, 3])]++;
  expect(counts.zero).toBe(0);
  expect(counts.one).toBeGreaterThan(4_400);
  expect(counts.one).toBeLessThan(5_600);
  expect(counts.three).toBe(20_000 - counts.one);
  expect(rng.weighted(['zero', 'only', 'zero'], [0, Number.MIN_VALUE, 0])).toBe(
    'only',
  );
});

test('int rejects invalid bounds rather than coercing or overflowing them', () => {
  const rng = createRng('invalid', 'field');
  for (const [min, max] of [
    [2, 1],
    [0.5, 2],
    [0, 1.5],
    [NaN, 1],
    [0, NaN],
    [-Infinity, 0],
    [0, Infinity],
    [Number.MIN_SAFE_INTEGER - 1, 0],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    expect(() => rng.int(min, max)).toThrow(RangeError);
  }
});

test('selection rejects empty items and malformed weights', () => {
  const rng = createRng('invalid-selection', 'field');
  expect(() => rng.pick([])).toThrow(RangeError);
  expect(() => rng.weighted([], [])).toThrow(RangeError);
  for (const weights of [
    [],
    [1],
    [1, 2, 3],
    [0, 0],
    [-1, 2],
    [NaN, 1],
    [1, Infinity],
    [-Infinity, 1],
  ]) {
    expect(() => rng.weighted(['a', 'b'], weights)).toThrow(RangeError);
  }
});
