// Derived fields (sum, percentage, runningBalance): computed after every
// drawn value exists, in dependency order, in exact decimal arithmetic.
// A number is read as the decimal it prints as (its shortest round-trip
// form), summed as a BigInt over a power of ten, and turned back into a
// number only if that number prints as exactly the same decimal.
import type { RuleField, Rules } from '@pdf-generator/contract';
import type { Issue } from './errors.ts';
import type { FakeRecord, FakeValue } from './schema.ts';

/** units / 10^scale. */
type Decimal = { units: bigint; scale: number };

const zero: Decimal = { units: 0n, scale: 0 };
const pow10 = (n: number) => 10n ** BigInt(n);

function toDecimal(value: number): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (!match) throw new RangeError(`not a finite number: ${value}`);
  const [, sign, whole, fraction = '', exponent = '0'] = match as string[];
  let units = BigInt(`${whole}${fraction}`);
  let scale = (fraction?.length ?? 0) - Number(exponent);
  if (scale < 0) {
    units *= pow10(-scale);
    scale = 0;
  }
  return { units: sign ? -units : units, scale };
}

function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    units: a.units * pow10(scale - a.scale) + b.units * pow10(scale - b.scale),
    scale,
  };
}

// Without trailing zeros, so equal values compare equal.
function normal({ units, scale }: Decimal): Decimal {
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale--;
  }
  return { units, scale };
}

/** The number that prints as exactly `value`, or undefined if there is none. */
function toNumber(value: Decimal): number | undefined {
  const { units, scale } = normal(value);
  if (units === 0n) return 0;
  const digits = (units < 0n ? -units : units)
    .toString()
    .padStart(scale + 1, '0');
  const text = `${units < 0n ? '-' : ''}${digits.slice(0, digits.length - scale)}${scale > 0 ? `.${digits.slice(-scale)}` : ''}`;
  const number = Number(text);
  const back = normal(toDecimal(number));
  return back.units === units && back.scale === scale ? number : undefined;
}

/** a / b × 100 to `decimals` places, half away from zero; undefined when b is 0. */
function percentage(
  a: Decimal,
  b: Decimal,
  decimals: number,
): Decimal | undefined {
  if (b.units === 0n) return undefined;
  // a.units / 10^a.scale ÷ (b.units / 10^b.scale) × 100 × 10^decimals
  let numerator = a.units * pow10(b.scale + decimals) * 100n;
  let denominator = b.units * pow10(a.scale);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const magnitude = numerator < 0n ? -numerator : numerator;
  let units = magnitude / denominator;
  if (2n * (magnitude % denominator) >= denominator) units++;
  return { units: numerator < 0n ? -units : units, scale: decimals };
}

type Derived = Extract<
  RuleField,
  { type: 'sum' | 'runningBalance' | 'percentage' }
>;

/** A derived field of the rule file, at its field path (e.g. `rows[].total`). */
export interface DerivedField {
  path: string;
  rulePath: (string | number)[];
  field: Derived;
}

const isDerived = (field: RuleField): field is Derived =>
  field.type === 'sum' ||
  field.type === 'runningBalance' ||
  field.type === 'percentage';

function references(field: Derived): string[] {
  switch (field.type) {
    case 'sum':
      return field.of;
    case 'percentage':
      return [field.part, field.whole];
    case 'runningBalance':
      return [field.opening, ...field.add, ...field.subtract];
  }
}

/**
 * The rule file's derived fields, ordered so each comes after the derived
 * fields it reads; a cycle is a rule-file issue at every field on it.
 */
export function derivedOrder(rules: Rules): {
  order: DerivedField[];
  issues: Issue[];
} {
  const fields = new Map<string, DerivedField>();
  const visit = (
    field: RuleField,
    path: string,
    rulePath: (string | number)[],
  ) => {
    if (isDerived(field)) fields.set(path, { path, rulePath, field });
    if (field.type === 'object') {
      for (const [key, child] of Object.entries(field.fields)) {
        visit(child, `${path}.${key}`, [...rulePath, 'fields', key]);
      }
    }
    if (field.type === 'array')
      visit(field.items, `${path}[]`, [...rulePath, 'items']);
  };
  for (const [key, field] of Object.entries(rules.fields))
    visit(field, key, ['fields', key]);

  const order: DerivedField[] = [];
  const issues: Issue[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: DerivedField[] = [];
  const place = (derived: DerivedField) => {
    const seen = state.get(derived.path);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const cycle = stack.slice(stack.indexOf(derived));
      const names = [...cycle, derived].map(({ path }) => path).join(' → ');
      for (const { rulePath } of cycle) {
        issues.push({
          path: rulePath,
          message: `derived fields depend on each other: ${names}`,
        });
      }
      return;
    }
    state.set(derived.path, 'visiting');
    stack.push(derived);
    for (const path of references(derived.field)) {
      const target = fields.get(path);
      if (target) place(target);
    }
    stack.pop();
    state.set(derived.path, 'done');
    order.push(derived);
  };
  for (const derived of fields.values()) place(derived);
  return { order, issues };
}

type Container = { [key: string]: FakeValue } | FakeValue[];
const isContainer = (value: FakeValue | undefined): value is Container =>
  typeof value === 'object' && value !== null;

/** Where a field's values sit in the record: holder and key, for every array item on the way. */
function slots(
  record: FakeRecord,
  path: string,
): { holder: Container; key: string | number }[] {
  let nodes: FakeValue[] = [record];
  const segments = path.split('.');
  const found: { holder: Container; key: string | number }[] = [];
  segments.forEach((segment, i) => {
    const each = segment.endsWith('[]');
    const name = each ? segment.slice(0, -2) : segment;
    const last = i === segments.length - 1;
    const next: FakeValue[] = [];
    for (const node of nodes) {
      if (!isContainer(node) || Array.isArray(node)) continue;
      if (last && !each) {
        found.push({ holder: node, key: name });
        continue;
      }
      const value = node[name];
      if (each) {
        if (!Array.isArray(value)) continue;
        value.forEach((item, index) => {
          if (last) found.push({ holder: value, key: index });
          else next.push(item);
        });
      } else if (value !== undefined) next.push(value);
    }
    nodes = next;
  });
  return found;
}

const read = (
  holder: Container,
  key: string | number,
): FakeValue | undefined =>
  Array.isArray(holder) ? holder[key as number] : holder[key as string];

/** The sum of every value `path` reaches; null counts as 0. */
function total(record: FakeRecord, path: string): Decimal {
  let sum = zero;
  for (const { holder, key } of slots(record, path)) {
    const value = read(holder, key);
    if (typeof value === 'number') sum = add(sum, toDecimal(value));
  }
  return sum;
}

class Unprintable extends Error {}

function print(value: Decimal | undefined): number | null {
  if (value === undefined) return null;
  const number = toNumber(value);
  if (number === undefined) throw new Unprintable();
  return number;
}

function compute(record: FakeRecord, field: Derived): number | null {
  switch (field.type) {
    case 'sum':
      return print(
        field.of.reduce((sum, path) => add(sum, total(record, path)), zero),
      );
    case 'percentage':
      return print(
        percentage(
          total(record, field.part),
          total(record, field.whole),
          field.decimals,
        ),
      );
    case 'runningBalance':
      throw new Error('unreachable: runningBalance is rejected up front');
  }
}

/**
 * Fills every derived field of `record` in place, in `order`. A field the
 * blank draw left null stays null. Returns the rule-file issues of results
 * that no number prints exactly.
 */
export function fillDerived(
  record: FakeRecord,
  order: DerivedField[],
): Issue[] {
  const issues: Issue[] = [];
  for (const { path, rulePath, field } of order) {
    const targets = slots(record, path).filter(
      ({ holder, key }) => read(holder, key) !== null,
    );
    if (targets.length === 0) continue;
    let value: number | null;
    try {
      // Paths reach the same values from every slot, so compute once.
      value = compute(record, field);
    } catch (error) {
      if (!(error instanceof Unprintable)) throw error;
      issues.push({
        path: rulePath,
        message: 'the exact result has more digits than a number can print',
      });
      continue;
    }
    for (const { holder, key } of targets) {
      if (Array.isArray(holder)) holder[key as number] = value;
      else holder[key as string] = value;
    }
  }
  return issues;
}
