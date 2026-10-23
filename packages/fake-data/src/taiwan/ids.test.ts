import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { beforeEach, expect, test } from 'vitest';
import { createRng } from '../random.ts';

let ids: typeof import('./ids.ts');
beforeEach(async () => {
  ids = await import('./ids.ts');
});

test('CLI generates 10,000 IDs of each kind passing independent checks and validators', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createRng } from ${JSON.stringify(new URL('../random.ts', import.meta.url).href)};
    import { nationalId, businessId, isValidNationalId, isValidBusinessId }
      from ${JSON.stringify(new URL('./ids.ts', import.meta.url).href)};
    // Code order encodes the exceptional I/O/W/X/Y/Z assignments independently.
    const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
    const person = createRng('acceptance-ids', 'person');
    const business = createRng('acceptance-ids', 'business');
    for (let i = 0; i < 10_000; i++) {
      const id = nationalId(person);
      assert.match(id, /^[A-Z][12][0-9]{8}$/);
      const expanded = String(letters.indexOf(id[0]) + 10) + id.slice(1);
      const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
      const total = [...expanded].reduce((sum, digit, j) => sum + Number(digit) * weights[j], 0);
      assert.equal(total % 10, 0, id);
      assert.equal(isValidNationalId(id), true, id);
      const tax = businessId(business);
      assert.match(tax, /^[0-9]{8}$/);
      const products = [...tax].map((digit, j) => Number(digit) * [1, 2, 1, 2, 1, 2, 4, 1][j]);
      const sum = products.flatMap(n => [...String(n)]).reduce((s, d) => s + Number(d), 0);
      assert.ok(sum % 10 === 0 || (tax[6] === '7' && (sum + 1) % 10 === 0), tax);
      assert.equal(isValidBusinessId(tax), true, tax);
    }
    console.log('10000 national IDs + 10000 business IDs independently verified');
  `;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
    }).trim(),
  ).toBe('10000 national IDs + 10000 business IDs independently verified');
});

test('national ID validator handles every letter mapping and rejects check-digit tampering', () => {
  // For the stem <letter>12345678, the numeric part contributes 120.
  const codes = [
    10, 11, 12, 13, 14, 15, 16, 17, 34, 18, 19, 20, 21, 22, 35, 23, 24, 25, 26,
    27, 28, 29, 32, 30, 31, 33,
  ];
  for (const [index, code] of codes.entries()) {
    const check =
      (10 - ((Math.floor(code / 10) + (code % 10) * 9 + 120) % 10)) % 10;
    const stem = `${String.fromCharCode(65 + index)}12345678`;
    expect(ids.isValidNationalId(`${stem}${check}`), stem).toBe(true);
    for (let digit = 0; digit < 10; digit++) {
      if (digit !== check)
        expect(ids.isValidNationalId(`${stem}${digit}`), stem).toBe(false);
    }
  }
  expect(ids.isValidNationalId('A123456789')).toBe(true);
  expect(ids.isValidNationalId('A223456781')).toBe(true);
});

test('national ID validator rejects coercion and resident-certificate formats', () => {
  for (const value of [
    '',
    'a123456789',
    'A12345678',
    'A1234567890',
    ' A123456789',
    'A123456789\n',
    'A12345678９',
    'A023456787',
    'A823456783',
    'A923456785',
    'AB23456789',
    '1123456789',
    '@123456789',
  ])
    expect(ids.isValidNationalId(value), value).toBe(false);
});

test('business validator accepts current modulo-five and seventh-digit-seven exceptions', () => {
  // 22099131 totals 40; 00000005 totals 5 (current-only).
  // 00000074 totals 14, so only the seventh-digit-seven +1 exception passes.
  for (const value of ['22099131', '00000005', '00000074', '00000070'])
    expect(ids.isValidBusinessId(value), value).toBe(true);
  for (const value of [
    '22099132',
    '00000004',
    '00000063',
    '00000073',
    '',
    '2209913',
    '220991310',
    ' 22099131',
    '22099131\n',
    '２2099131',
    '2209A131',
  ])
    expect(ids.isValidBusinessId(value), value).toBe(false);
});

test('gender selection honors explicit choices and both default and any produce both genders', () => {
  for (const gender of ['male', 'female', 'any', undefined] as const) {
    const rng = createRng('gender', String(gender));
    const values = Array.from({ length: 200 }, () =>
      ids.nationalId(rng, gender),
    );
    expect(new Set(values.map(value => value[1]))).toEqual(
      new Set(
        gender === 'male' ? ['1'] : gender === 'female' ? ['2'] : ['1', '2'],
      ),
    );
    expect(values.every(ids.isValidNationalId)).toBe(true);
  }
});

test('ID streams replay from seed and path without shared generator state', () => {
  const draw = (seed: string, path: string) => {
    const rng = createRng(seed, path);
    return Array.from({ length: 30 }, () => [
      ids.nationalId(rng),
      ids.businessId(rng),
    ]);
  };
  const original = draw('replay', 'ids');
  draw('noise', 'unrelated');
  expect(draw('replay', 'ids')).toEqual(original);
  expect(draw('changed', 'ids')).not.toEqual(original);
  expect(draw('replay', 'other')).not.toEqual(original);
});
