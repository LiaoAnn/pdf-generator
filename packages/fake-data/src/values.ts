import type { Rng } from './random.ts';

// Days since 0000-03-01 in the proleptic Gregorian calendar, by integer
// arithmetic only (H. Hinnant's days_from_civil), so no Date or time zone.
function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra;
}

function civilDate(days: number): string {
  const era = Math.floor(days / 146097);
  const dayOfEra = days - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

const daysInMonth = (year: number, month: number) =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

// The day number of a YYYY-MM-DD calendar date (years 0001-9999), else undefined.
function parseDate(value: string): number | undefined {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  if (year < 1 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return dayNumber(year, month, day);
}

/** Whether `value` is YYYY-MM-DD naming a real Gregorian day, years 0001-9999. */
export function isCalendarDate(value: string): boolean {
  return parseDate(value) !== undefined;
}

/** Uniformly chosen day in [min, max] inclusive, as YYYY-MM-DD. */
export function date(rng: Rng, min: string, max: string): string {
  const from = parseDate(min);
  const to = parseDate(max);
  if (from === undefined || to === undefined || from > to) {
    throw new RangeError(`invalid date range ${min} to ${max}`);
  }
  return civilDate(rng.int(from, to));
}

/**
 * The integers k with k / 10^decimals in [min, max]: every value `decimal`
 * can return. Throws RangeError when there is none or they are not all safe
 * integers.
 */
export function decimalRange(
  min: number,
  max: number,
  decimals: number,
): { low: number; high: number; scale: number } {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min > max ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 6
  ) {
    throw new RangeError(
      `invalid range [${min}, ${max}] to ${decimals} places`,
    );
  }
  const scale = 10 ** decimals;
  // Beyond 2^53 neighbouring integers collapse and the adjustments below
  // would never finish, so reject such ranges first.
  if (
    !Number.isSafeInteger(Math.round(min * scale)) ||
    !Number.isSafeInteger(Math.round(max * scale))
  ) {
    throw new RangeError(
      `[${min}, ${max}] to ${decimals} places is too wide to draw from`,
    );
  }
  let low = Math.round(min * scale);
  while (low / scale < min) low++;
  while ((low - 1) / scale >= min) low--;
  let high = Math.round(max * scale);
  while (high / scale > max) high--;
  while ((high + 1) / scale <= max) high++;
  if (low > high) {
    throw new RangeError(
      `no value in [${min}, ${max}] has ${decimals} decimal places`,
    );
  }
  if (!Number.isSafeInteger(high - low)) {
    throw new RangeError(
      `[${min}, ${max}] to ${decimals} places is too wide to draw from`,
    );
  }
  return { low, high, scale };
}

/** Number in [min, max] with at most `decimals` (0-6) decimal places, uniform over those values. */
export function decimal(
  rng: Rng,
  min: number,
  max: number,
  decimals: number,
): number {
  // Values are k / scale for integer k; dividing an integer by a power of 10
  // gives the double nearest to the decimal, which toFixed round-trips.
  const { low, high, scale } = decimalRange(min, max, decimals);
  return rng.int(low, high) / scale;
}
