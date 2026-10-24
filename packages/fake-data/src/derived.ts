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
const negate = (a: Decimal): Decimal => ({ units: -a.units, scale: a.scale });

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
  if (!Number.isFinite(number)) return undefined;
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

/** A running balance's rows: the array of its last `[]` (e.g. `a[].b[]`). */
function rowsOf(path: string): string | undefined {
  const end = path.lastIndexOf('[]');
  return end < 0 ? undefined : path.slice(0, end + 2);
}

const through = (path: string, array: string) =>
  path === array || path.startsWith(`${array}.`);

/** Where a running balance's paths must, or must not, go. */
function placement({ path, rulePath, field }: DerivedField): Issue[] {
  if (field.type !== 'runningBalance') return [];
  const rows = rowsOf(path);
  if (rows === undefined) {
    return [
      { path: rulePath, message: 'a running balance must be in an array item' },
    ];
  }
  const issues: Issue[] = [];
  for (const key of ['add', 'subtract'] as const) {
    field[key].forEach((each, i) => {
      if (!through(each, rows)) {
        issues.push({
          path: [...rulePath, key, i],
          message: `${each} does not go through the rows ${rows}`,
        });
      }
    });
  }
  if (through(field.opening, rows)) {
    issues.push({
      path: [...rulePath, 'opening'],
      message: `the opening must not go through the rows ${rows}`,
    });
  }
  return issues;
}

/**
 * The rule file's derived fields, ordered so each comes after the derived
 * fields it reads. Issues: a cycle (at every field on it), and a running
 * balance outside an array item or with paths that miss its rows.
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
  const issues = [...fields.values()].flatMap(placement);
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

/** Array field path (e.g. `rows[]`) → the index of the item it stands for. */
type Bound = ReadonlyMap<string, number>;
type Slot = { holder: Container; key: string | number; bound: Bound };

/**
 * Where a field's values sit in the record. An array on the path gives
 * every item, or only the item `bound` names for it; each slot records the
 * items it went through. A segment may end in several `[]` (an array of
 * arrays, as a derived field's own path can).
 */
function slots(record: FakeRecord, path: string, bound: Bound = new Map()) {
  // One step per key and per `[]`; an item step carries its path so far.
  const steps: ({ key: string } | { items: string })[] = [];
  let prefix = '';
  for (const segment of path.split('.')) {
    const name = segment.replace(/(\[\])+$/, '');
    prefix += `${prefix === '' ? '' : '.'}${name}`;
    steps.push({ key: name });
    for (let i = name.length; i < segment.length; i += 2) {
      prefix += '[]';
      steps.push({ items: prefix });
    }
  }
  let nodes: { value: FakeValue; bound: Bound }[] = [{ value: record, bound }];
  const found: Slot[] = [];
  steps.forEach((step, i) => {
    const last = i === steps.length - 1;
    const next: typeof nodes = [];
    for (const node of nodes) {
      const { value } = node;
      if ('key' in step) {
        if (!isContainer(value) || Array.isArray(value)) continue;
        if (last)
          found.push({ holder: value, key: step.key, bound: node.bound });
        else if (value[step.key] !== undefined) {
          next.push({ value: value[step.key] ?? null, bound: node.bound });
        }
        continue;
      }
      if (!Array.isArray(value)) continue;
      const only = node.bound.get(step.items);
      const indices =
        only === undefined ? value.keys() : only < value.length ? [only] : [];
      for (const index of indices) {
        const itemBound = new Map(node.bound).set(step.items, index);
        if (last) found.push({ holder: value, key: index, bound: itemBound });
        else next.push({ value: value[index] ?? null, bound: itemBound });
      }
    }
    nodes = next;
  });
  return found;
}

const read = (holder: Container, key: string | number) =>
  Array.isArray(holder) ? holder[key as number] : holder[key as string];

function write(holder: Container, key: string | number, value: FakeValue) {
  if (Array.isArray(holder)) holder[key as number] = value;
  else holder[key as string] = value;
}

type Totals = {
  /** The sum of every value `path` reaches; null counts as 0. */
  total: (path: string, bound?: Bound) => Decimal;
  /** The sum over `paths`, a path listed twice counting twice. */
  totals: (paths: string[], bound?: Bound) => Decimal;
};

/**
 * Path totals over one record. Each total is computed once per item of the
 * bound arrays it goes through, and a repeated path once, so derived fields
 * read each value a bounded number of times. Totals never go stale: a path
 * is read only after the derived fields it reaches are filled.
 */
function totalsOf(record: FakeRecord): Totals {
  const memo = new Map<string, Decimal>();
  const total = (path: string, bound: Bound = new Map()) => {
    const used = [...bound].filter(([array]) => through(path, array));
    const key = `${path}|${used.map(([, index]) => index).join(',')}`;
    let sum = memo.get(key);
    if (sum === undefined) {
      sum = zero;
      for (const { holder, key } of slots(record, path, new Map(used))) {
        const value = read(holder, key);
        if (typeof value === 'number') sum = add(sum, toDecimal(value));
      }
      memo.set(key, sum);
    }
    return sum;
  };
  const totals = (paths: string[], bound?: Bound) => {
    const counts = new Map<string, number>();
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
    let sum = zero;
    for (const [path, count] of counts) {
      const { units, scale } = total(path, bound);
      sum = add(sum, { units: units * BigInt(count), scale });
    }
    return sum;
  };
  return { total, totals };
}

class Unprintable extends Error {}

function print(value: Decimal | undefined): number | null {
  if (value === undefined) return null;
  const number = toNumber(value);
  if (number === undefined) throw new Unprintable();
  return number;
}

// Sums and percentages read the same values from every slot: one value.
function fillOnce(
  record: FakeRecord,
  path: string,
  value: () => number | null,
) {
  const targets = slots(record, path).filter(
    ({ holder, key }) => read(holder, key) !== null,
  );
  if (targets.length === 0) return;
  const result = value();
  for (const { holder, key } of targets) write(holder, key, result);
}

// Row by row through each rows array; paths through the arrays around the
// rows, and through the rows themselves, refer to the current item.
function fillRunning(
  record: FakeRecord,
  { total, totals }: Totals,
  path: string,
  field: Extract<Derived, { type: 'runningBalance' }>,
) {
  const rows = rowsOf(path) as string;
  let holder: Container | undefined;
  let balance = zero;
  for (const row of slots(record, rows)) {
    if (row.holder !== holder) {
      holder = row.holder;
      balance = total(field.opening, row.bound);
    }
    if (read(row.holder, row.key) === null) continue;
    balance = add(balance, totals(field.add, row.bound));
    balance = add(balance, negate(totals(field.subtract, row.bound)));
    for (const target of slots(record, path, row.bound)) {
      if (read(target.holder, target.key) !== null) {
        write(target.holder, target.key, print(balance));
      }
    }
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
  const { total, totals } = totalsOf(record);
  for (const { path, rulePath, field } of order) {
    try {
      switch (field.type) {
        case 'sum':
          fillOnce(record, path, () => print(totals(field.of)));
          break;
        case 'percentage':
          fillOnce(record, path, () =>
            print(
              percentage(total(field.part), total(field.whole), field.decimals),
            ),
          );
          break;
        case 'runningBalance':
          fillRunning(record, { total, totals }, path, field);
          break;
      }
    } catch (error) {
      if (!(error instanceof Unprintable)) throw error;
      issues.push({
        path: rulePath,
        message: 'the exact result has more digits than a number can print',
      });
    }
  }
  return issues;
}
