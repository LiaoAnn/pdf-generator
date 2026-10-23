import type { Rng } from '../random.ts';

export type PhoneKind = 'mobile' | 'landline';

// Landline area codes and how the local number is grouped when printed
// (digits per group). 04 has 8 digits in 臺中 and 7 in 彰化.
const landlines: readonly { area: string; groups: readonly number[][] }[] = [
  { area: '02', groups: [[4, 4]] },
  { area: '03', groups: [[3, 4]] },
  { area: '037', groups: [[3, 3]] },
  {
    area: '04',
    groups: [
      [4, 4],
      [3, 4],
    ],
  },
  { area: '049', groups: [[3, 4]] },
  { area: '05', groups: [[3, 4]] },
  { area: '06', groups: [[3, 4]] },
  { area: '07', groups: [[3, 4]] },
  { area: '08', groups: [[3, 4]] },
  { area: '089', groups: [[3, 3]] },
  { area: '082', groups: [[3, 3]] },
  { area: '0836', groups: [[2, 3]] },
];
// Rough share of numbers per area: most fixtures should look metropolitan.
const landlineWeights = [30, 12, 3, 15, 3, 6, 8, 12, 4, 2, 1, 1];

const digits = (rng: Rng, count: number) => {
  let text = '';
  for (let i = 0; i < count; i++) text += String(rng.int(0, 9));
  return text;
};

/** Taiwanese phone number: mobile `09XX-XXX-XXX`, landline e.g. `02-XXXX-XXXX`. */
export function phone(rng: Rng, kind: PhoneKind): string {
  if (kind === 'mobile') {
    return `09${digits(rng, 2)}-${digits(rng, 3)}-${digits(rng, 3)}`;
  }
  const { area, groups } = rng.weighted(landlines, landlineWeights);
  const [first, second] = rng.pick(groups) as [number, number];
  // A local number never starts with 0 (trunk prefix) or 1 (special services).
  const head = `${rng.int(2, 9)}${digits(rng, first - 1)}`;
  return `${area}-${head}-${digits(rng, second)}`;
}

const mobilePattern = /^09[0-9]{2}-[0-9]{3}-[0-9]{3}$/;
const landlinePattern = new RegExp(
  `^(?:${landlines
    .flatMap(({ area, groups }) =>
      groups.map(
        ([first, second]) =>
          `${area}-[2-9][0-9]{${(first as number) - 1}}-[0-9]{${second}}`,
      ),
    )
    .join('|')})$`,
);

/** Whether `value` is a phone number of `kind` in the format `phone` prints. */
export function isValidPhone(value: string, kind: PhoneKind): boolean {
  return (kind === 'mobile' ? mobilePattern : landlinePattern).test(value);
}
