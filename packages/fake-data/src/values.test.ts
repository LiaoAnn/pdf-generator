import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { beforeEach, expect, test } from 'vitest';
import { createRng } from './random.ts';

let values: typeof import('./values.ts');
beforeEach(async () => {
  values = await import('./values.ts');
});

test('CLI samples 10,000 valid records and replays every generator by seed and path', () => {
  const moduleUrl = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import assert from 'node:assert/strict';
    import { createRng } from ${moduleUrl('./random.ts')};
    import { personName } from ${moduleUrl('./taiwan/names.ts')};
    import { address, isValidAddress } from ${moduleUrl('./taiwan/address.ts')};
    import { companyName } from ${moduleUrl('./taiwan/company.ts')};
    import { date, decimal, isCalendarDate } from ${moduleUrl('./values.ts')};
    const draw = (seed, path, count) => {
      const rng = createRng(seed, path);
      return Array.from({ length: count }, () => ({
        name: personName(rng), address: address(rng), company: companyName(rng),
        date: date(rng, '2024-01-01', '2026-12-31'),
        money: decimal(rng, -123.456, 987.654, 2), number: decimal(rng, -5, 5, 6),
      }));
    };
    const rows = draw('acceptance-values', 'record', 10_000);
    for (const row of rows) {
      assert.match(row.name, /^\\p{Script=Han}{2,4}$/u);
      assert.match(row.company, /^\\p{Script=Han}+(?:股份有限公司|有限公司)$/u);
      assert.equal(isValidAddress(row.address), true);
      assert.ok(isCalendarDate(row.date) && row.date >= '2024-01-01' && row.date <= '2026-12-31');
      assert.ok(row.money >= -123.456 && row.money <= 987.654);
      assert.equal(Number(row.money.toFixed(2)), row.money);
      assert.ok(row.number >= -5 && row.number <= 5);
      assert.equal(Number(row.number.toFixed(6)), row.number);
    }
    const original = JSON.stringify(rows.slice(0, 30));
    draw('noise', 'unrelated', 100);
    assert.equal(JSON.stringify(draw('acceptance-values', 'record', 30)), original);
    for (const [seed, path] of [['other', 'record'], ['acceptance-values', 'other']]) {
      const changed = draw(seed, path, 30);
      for (const key of Object.keys(rows[0]))
        assert.notDeepEqual(changed.map(row => row[key]), rows.slice(0, 30).map(row => row[key]));
    }
    console.log(JSON.stringify(rows[0]));
  `;
  const run = () =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  expect(run()).toBe(run());
});

test('calendar validation rejects rollover dates and enforces Gregorian century rules', () => {
  for (const value of [
    '0001-01-01',
    '0099-12-31',
    '2000-02-29',
    '2024-02-29',
    '9999-12-31',
  ])
    expect(values.isCalendarDate(value), value).toBe(true);
  for (const value of [
    '',
    '0000-01-01',
    '10000-01-01',
    '1900-02-29',
    '2026-02-29',
    '2024-04-31',
    '2024-00-01',
    '2024-13-01',
    '2024-01-00',
    '2024-01-32',
    '2024-2-01',
    '2024-02-1',
    '2024-02-01\n',
    ' 2024-02-01',
    '２０２４-02-01',
  ])
    expect(values.isCalendarDate(value), value).toBe(false);
});

test('date sampling reaches each inclusive day without leap-day gaps or gross bias', () => {
  const rng = createRng('leap-days', 'date');
  const counts = new Map<string, number>();
  for (let i = 0; i < 10_000; i++) {
    const day: string = values.date(rng, '2024-02-27', '2024-03-01');
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  expect([...counts.keys()].sort()).toEqual([
    '2024-02-27',
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
  ]);
  expect(
    [...counts.values()].every(count => count > 2_000 && count < 3_000),
  ).toBe(true);
  for (const day of ['0001-01-01', '0099-12-31', '9999-12-31'])
    expect(values.date(rng, day, day)).toBe(day);
});

test('date output is byte-identical across time zones including a DST transition', () => {
  const script = `
    import { createRng } from ${JSON.stringify(new URL('./random.ts', import.meta.url).href)};
    import { date } from ${JSON.stringify(new URL('./values.ts', import.meta.url).href)};
    const rng = createRng('timezone', 'date');
    console.log(JSON.stringify(Array.from({ length: 1000 }, () => date(rng, '2024-03-09', '2024-03-12'))));
  `;
  const outputs = ['UTC', 'Asia/Taipei', 'America/New_York'].map(TZ =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ },
      timeout: 10_000,
    }),
  );
  expect(new Set(outputs).size).toBe(1);
});

test('date rejects invalid bounds instead of normalizing or swapping them', () => {
  const rng = createRng('invalid', 'date');
  for (const [min, max] of [
    ['2026-02-29', '2026-03-01'],
    ['2024-01-01', '2024-04-31'],
    ['2024-03-01', '2024-02-29'],
    ['0000-01-01', '2024-01-01'],
  ] as const)
    expect(() => values.date(rng, min, max)).toThrow(RangeError);
});

test('decimal samples the inclusive grid without rounding outside fractional bounds', () => {
  const rng = createRng('decimal-grids', 'number');
  for (const [min, max, decimals, grid] of [
    [0.29, 0.31, 2, [0.29, 0.3, 0.31]],
    [-0.031, -0.009, 2, [-0.03, -0.02, -0.01]],
    [-1.9, 1.9, 0, [-1, 0, 1]],
    [0.000001, 0.000003, 6, [0.000001, 0.000002, 0.000003]],
  ] as const) {
    const counts = new Map<number, number>();
    for (let i = 0; i < 10_000; i++) {
      const value: number = values.decimal(rng, min, max, decimals);
      expect(value >= min && value <= max).toBe(true);
      expect(Number(value.toFixed(decimals))).toBe(value);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual(grid);
    expect(
      [...counts.values()].every(count => count > 2_700 && count < 4_000),
    ).toBe(true);
  }
  expect(values.decimal(rng, 1.231, 1.241, 2)).toBe(1.24);
});

test('decimal rejects empty grids, reversed or nonfinite bounds and invalid precision', () => {
  const rng = createRng('invalid', 'number');
  for (const [min, max, decimals] of [
    [0.001, 0.002, 2],
    [2, 1, 2],
    [NaN, 1, 2],
    [0, NaN, 2],
    [-Infinity, 0, 2],
    [0, Infinity, 2],
    [0, 1, -1],
    [0, 1, 7],
    [0, 1, 1.5],
    [0, 1, NaN],
    [0, 1, Infinity],
  ] as const)
    expect(() => values.decimal(rng, min, max, decimals)).toThrow(RangeError);
  expect(values.decimal(rng, -2.5, -2.5, 1)).toBe(-2.5);
});
