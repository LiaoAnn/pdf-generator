import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { beforeEach, expect, test } from 'vitest';
import { createRng } from '../random.ts';

let phones: typeof import('./phone.ts');
beforeEach(async () => {
  phones = await import('./phone.ts');
});

test('CLI generates 10,000 phones per kind with independent format checks and area coverage', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createRng } from ${JSON.stringify(new URL('../random.ts', import.meta.url).href)};
    import { phone, isValidPhone } from ${JSON.stringify(new URL('./phone.ts', import.meta.url).href)};
    const areas = new Set();
    const lengths = { '02': [4,4], '03': [3,4], '037': [3,3], '04': [3,4],
      '049': [3,4], '05': [3,4], '06': [3,4], '07': [3,4], '08': [3,4],
      '089': [3,3], '082': [3,3], '0836': [2,3] };
    for (const kind of ['mobile', 'landline']) {
      const rng = createRng('acceptance-phones', kind);
      for (let i = 0; i < 10_000; i++) {
        const value = phone(rng, kind);
        if (kind === 'mobile') assert.match(value, /^09[0-9]{2}-[0-9]{3}-[0-9]{3}$/);
        else {
          const parts = value.split('-');
          assert.equal(parts.length, 3, value);
          const [area, first, last] = parts;
          assert.ok(Object.hasOwn(lengths, area), value);
          assert.match(first, /^[2-9][0-9]*$/);
          assert.match(last, /^[0-9]+$/);
          const [left, right] = lengths[area];
          assert.ok(first.length === left || (area === '04' && first.length === 4), value);
          assert.equal(last.length, right, value);
          areas.add(area);
        }
        assert.equal(isValidPhone(value, kind), true, value);
      }
    }
    assert.ok(areas.has('02') && areas.has('04'));
    assert.ok([...areas].some(area => area.length >= 3));
    console.log('10000 mobile + 10000 landline numbers independently verified');
  `;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
    }).trim(),
  ).toBe('10000 mobile + 10000 landline numbers independently verified');
});

test('validator accepts every supported landline grouping and keeps phone kinds separate', () => {
  for (const value of [
    '02-2345-6789',
    '03-234-5678',
    '037-234-567',
    '04-234-5678',
    '04-2345-6789',
    '049-234-5678',
    '05-234-5678',
    '06-234-5678',
    '07-234-5678',
    '08-234-5678',
    '089-234-567',
    '082-234-567',
    '0836-23-456',
  ]) {
    expect(phones.isValidPhone(value, 'landline'), value).toBe(true);
    expect(phones.isValidPhone(value, 'mobile'), value).toBe(false);
    for (const first of ['0', '1']) {
      const invalid = value.replace(/-[2-9]/, `-${first}`);
      expect(phones.isValidPhone(invalid, 'landline'), invalid).toBe(false);
    }
  }
  for (const value of ['0912-345-678', '0900-000-000', '0999-999-999']) {
    expect(phones.isValidPhone(value, 'mobile'), value).toBe(true);
    expect(phones.isValidPhone(value, 'landline'), value).toBe(false);
  }
});

test('validator rejects unknown areas, incorrect lengths, grouping and non-ASCII input', () => {
  for (const value of [
    '01-234-5678',
    '09-234-5678',
    '038-234-567',
    '0837-23-456',
    '02-234-5678',
    '03-2345-6789',
    '037-234-5678',
    '049-234-567',
    '05-2345-6789',
    '06-234-567',
    '07-234-56789',
    '08-2345-6789',
    '089-234-5678',
    '082-23-456',
    '0836-234-567',
    '04-23-45678',
    '0223456789',
    '(02)2345-6789',
    '+886-2-2345-6789',
    '02-2345-6789\n',
    ' 02-2345-6789',
    '02-２345-6789',
    '',
  ])
    expect(phones.isValidPhone(value, 'landline'), value).toBe(false);
  for (const value of [
    '0912345678',
    '091-234-5678',
    '0912-34-5678',
    '0912-345-67',
    '0912-345-6789',
    '0812-345-678',
    '+886-912-345-678',
    '0912-345-678\n',
    ' 0912-345-678',
    '091２-345-678',
    '',
  ])
    expect(phones.isValidPhone(value, 'mobile'), value).toBe(false);
});

test('phone streams replay per seed and path independently of unrelated draws', () => {
  const draw = (seed: string, path: string) => {
    const rng = createRng(seed, path);
    return Array.from({ length: 30 }, () => [
      phones.phone(rng, 'mobile'),
      phones.phone(rng, 'landline'),
    ]);
  };
  const original = draw('replay', 'phones');
  draw('noise', 'unrelated');
  expect(draw('replay', 'phones')).toEqual(original);
  expect(draw('changed', 'phones')).not.toEqual(original);
  expect(draw('replay', 'other')).not.toEqual(original);
});
