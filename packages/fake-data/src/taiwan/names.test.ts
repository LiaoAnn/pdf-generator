import { beforeEach, expect, test } from 'vitest';
import { createRng } from '../random.ts';

let names: typeof import('./names.ts');
beforeEach(async () => {
  names = await import('./names.ts');
});

test('gender selects distinct given-name pools and default and any mix both', () => {
  const endings = (gender?: 'male' | 'female' | 'any') => {
    const rng = createRng('name-pools', 'person');
    const values: string[] = Array.from({ length: 10_000 }, () =>
      names.personName(rng, gender),
    );
    expect(values.every(value => /^\p{Script=Han}{2,4}$/u.test(value))).toBe(
      true,
    );
    return new Set(values.map(value => value.slice(-1)));
  };
  const male = endings('male');
  const female = endings('female');
  const maleOnly = [...male].filter(char => !female.has(char));
  const femaleOnly = [...female].filter(char => !male.has(char));
  expect(maleOnly.length).toBeGreaterThan(0);
  expect(femaleOnly.length).toBeGreaterThan(0);
  for (const mixed of [endings(), endings('any')]) {
    expect(maleOnly.some(char => mixed.has(char))).toBe(true);
    expect(femaleOnly.some(char => mixed.has(char))).toBe(true);
  }
});
