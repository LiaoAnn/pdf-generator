import { beforeEach, expect, test } from 'vitest';
import { createRng } from '../random.ts';

let companies: typeof import('./company.ts');
beforeEach(async () => {
  companies = await import('./company.ts');
});

test('company draws reach both legal suffixes without collapsing to one name', () => {
  const rng = createRng('company-forms', 'company');
  const values: string[] = Array.from({ length: 10_000 }, () =>
    companies.companyName(rng),
  );
  expect(values.some(value => value.endsWith('股份有限公司'))).toBe(true);
  expect(values.some(value => /(?<!股份)有限公司$/u.test(value))).toBe(true);
  expect(new Set(values).size).toBeGreaterThan(1);
});
