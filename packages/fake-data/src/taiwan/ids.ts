import type { Rng } from '../random.ts';

export type Gender = 'male' | 'female' | 'any';

// 身分證字號 letter codes, indexed by letter (A = 0). Not alphabetical: I, O,
// W-Z were assigned out of order.
const letterCodes = [
  10, 11, 12, 13, 14, 15, 16, 17, 34, 18, 19, 20, 21, 22, 35, 23, 24, 25, 26,
  27, 28, 29, 32, 30, 31, 33,
];
const nationalIdWeights = [8, 7, 6, 5, 4, 3, 2, 1];

// Weighted sum of the letter and the 8 characters before the check digit.
function nationalIdStemSum(letter: number, digits: string): number {
  const code = letterCodes[letter] as number;
  let sum = Math.floor(code / 10) + (code % 10) * 9;
  for (let i = 0; i < 8; i++) {
    sum += Number(digits[i]) * (nationalIdWeights[i] as number);
  }
  return sum;
}

/** 身分證字號 with a valid check digit; the second digit is 1 (male) or 2 (female). */
export function nationalId(rng: Rng, gender: Gender = 'any'): string {
  const letter = rng.int(0, 25);
  const sex =
    gender === 'male' ? 1 : gender === 'female' ? 2 : rng.pick([1, 2]);
  let digits = String(sex);
  for (let i = 0; i < 7; i++) digits += String(rng.int(0, 9));
  const check = (10 - (nationalIdStemSum(letter, digits) % 10)) % 10;
  return `${String.fromCharCode(65 + letter)}${digits}${check}`;
}

/** Whether `value` is a 身分證字號 (^[A-Z][12]\d{8}$) with the correct check digit. */
export function isValidNationalId(value: string): boolean {
  if (!/^[A-Z][12][0-9]{8}$/.test(value)) return false;
  const sum = nationalIdStemSum(value.charCodeAt(0) - 65, value.slice(1, 9));
  return (sum + Number(value[9])) % 10 === 0;
}

const businessIdWeights = [1, 2, 1, 2, 1, 2, 4, 1];

// Sum of the digit sums of each digit × weight; a 7 in the 7th place adds 10.
function businessIdSum(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const product = Number(digits[i]) * (businessIdWeights[i] as number);
    sum += Math.floor(product / 10) + (product % 10);
  }
  return sum;
}

/** 統一編號 valid under the legacy rule (checksum divisible by 10), so also under the current one. */
export function businessId(rng: Rng): string {
  let stem = '';
  for (let i = 0; i < 7; i++) stem += String(rng.int(0, 9));
  // The last digit has weight 1, so exactly one digit makes the sum a multiple of 10.
  const check = (10 - (businessIdSum(stem) % 10)) % 10;
  return `${stem}${check}`;
}

/**
 * Whether `value` is a 統一編號 under the Ministry of Finance's current rule:
 * the checksum is divisible by 5, or, when the 7th digit is 7 (7 × 4 = 28,
 * whose digits add to 10, counted as 1 or 0), the checksum + 1 is.
 */
export function isValidBusinessId(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) return false;
  const sum = businessIdSum(value);
  return sum % 5 === 0 || (value[6] === '7' && (sum + 1) % 5 === 0);
}
