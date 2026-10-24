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
const powers: bigint[] = [];
const pow10 = (n: number) => {
  let power = powers[n];
  if (power === undefined) {
    power = 10n ** BigInt(n);
    powers[n] = power;
  }
  return power;
};
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

// Without trailing zeros, so equal values compare equal. The zeros are
// found by halving steps (divisibility by 10^k is monotone in k), a few
// divisions however long the number is.
function normal({ units, scale }: Decimal): Decimal {
  if (units === 0n) return { units, scale: 0 };
  let zeros = 0;
  for (
    let step = 2 ** Math.floor(Math.log2(scale || 1));
    step >= 1;
    step /= 2
  ) {
    if (zeros + step <= scale && units % pow10(step) === 0n) {
      units /= pow10(step);
      zeros += step;
    }
  }
  return { units, scale: scale - zeros };
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

/** The most derived-field evaluation steps one record may take. */
const maxDerivedSteps = 1_000_000;

/**
 * The rule file's derived fields, ordered so each comes after the derived
 * fields it reads. Issues: too many worst-case steps, a cycle (at every
 * field on it), and a running balance outside an array item or with paths
 * that miss its rows.
 */
export function derivedOrder(rules: Rules): {
  order: DerivedField[];
  issues: Issue[];
} {
  const fields = new Map<string, DerivedField>();
  // Worst-case evaluation steps: each instance of a running balance reads
  // each of its distinct paths below its row, as many values as the path
  // fans out there (at least one lookup); a sum or percentage is computed
  // once (path totals are memoized).
  let steps = 0;
  // How many nodes `path` reaches at its widest level after its first
  // `skip` arrays: the largest running product of their maxItems. An empty
  // array further down doesn't make the walk above it free.
  const fanOut = (path: string, skip: number) => {
    let fields: Rules['fields'] | undefined = rules.fields;
    let product = 1;
    let widest = 1;
    let arrays = 0;
    for (const segment of path.split('.')) {
      const name = segment.replace(/(\[\])+$/, '');
      let field: RuleField | undefined = fields?.[name];
      for (let i = name.length; i < segment.length; i += 2) {
        if (field?.type !== 'array') return widest;
        if (arrays++ >= skip) {
          product *= field.maxItems;
          widest = Math.max(widest, product);
        }
        field = field.items;
      }
      fields = field?.type === 'object' ? field.fields : undefined;
    }
    return widest;
  };
  const visit = (
    field: RuleField,
    path: string,
    rulePath: (string | number)[],
    instances: number,
  ) => {
    if (isDerived(field)) {
      fields.set(path, { path, rulePath, field });
      if (field.type === 'runningBalance') {
        const skip = (rowsOf(path) ?? '').split('[]').length - 1;
        for (const each of new Set([...field.add, ...field.subtract])) {
          steps += instances * fanOut(each, skip);
        }
      } else steps += new Set(references(field)).size;
    }
    if (field.type === 'object') {
      for (const [key, child] of Object.entries(field.fields)) {
        visit(child, `${path}.${key}`, [...rulePath, 'fields', key], instances);
      }
    }
    if (field.type === 'array')
      visit(
        field.items,
        `${path}[]`,
        [...rulePath, 'items'],
        instances * field.maxItems,
      );
  };
  for (const [key, field] of Object.entries(rules.fields))
    visit(field, key, ['fields', key], 1);
  if (steps > maxDerivedSteps) {
    return {
      order: [],
      issues: [
        {
          path: ['fields'],
          message: `derived fields would take up to ${steps} steps; the limit is ${maxDerivedSteps}`,
        },
      ],
    };
  }

  const order: DerivedField[] = [];
  const issues = [...fields.values()].flatMap(placement);
  // Depth-first without recursion, so a long chain cannot overflow the
  // stack; the first cycle found is reported, once per field on it.
  const state = new Map<string, 'visiting' | 'done'>();
  type Frame = { derived: DerivedField; next: Iterator<string> };
  const frame = (derived: DerivedField): Frame => {
    state.set(derived.path, 'visiting');
    return { derived, next: new Set(references(derived.field)).values() };
  };
  for (const start of fields.values()) {
    if (state.has(start.path)) continue;
    const frames = [frame(start)];
    while (frames.length > 0) {
      const top = frames[frames.length - 1] as Frame;
      const step = top.next.next();
      if (step.done) {
        frames.pop();
        state.set(top.derived.path, 'done');
        order.push(top.derived);
        continue;
      }
      const target = fields.get(step.value);
      if (target === undefined || state.get(target.path) === 'done') continue;
      if (state.get(target.path) === 'visiting') {
        const cycle = frames
          .slice(frames.findIndex(({ derived }) => derived === target))
          .map(({ derived }) => derived);
        cycle.forEach(({ path, rulePath }, i) => {
          const reads = (cycle[i + 1] ?? target).path;
          issues.push({
            path: rulePath,
            message: `${path} reads ${reads}, which depends on ${path}`,
          });
        });
        return { order, issues };
      }
      frames.push(frame(target));
    }
  }
  return { order, issues };
}

type Container = { [key: string]: FakeValue } | FakeValue[];
const isContainer = (value: FakeValue | undefined): value is Container =>
  typeof value === 'object' && value !== null;

/** An array's items prefix (`a[].b[]`) → the index of the item it stands for. */
type Bound = ReadonlyMap<Prefix, number>;
type Slot = { holder: Container; key: string | number; bound: Bound };

/**
 * A field path compiled once against the rules: one step per key and per
 * `[]` (a derived field's own path may hold several, for an array of
 * arrays). Each step names its prefix (`at`, the same object for every
 * path with that prefix, even when the rules reuse one rule object in two
 * places) and the item prefixes of the arrays passed so far, so binding
 * and lookups never depend on how long the names are.
 */
type Prefix = Map<string, Prefix>;
type Step = ({ key: string } | { items: true }) & {
  at: Prefix;
  arrays: Prefix[];
};
type Compiled = { steps: Step[]; arrays: Prefix[] };

function compiler(rules: Rules) {
  const compiled = new Map<string, Compiled>();
  // A trie of prefixes: a key, or `[]` (never a key) for the items.
  const root: Prefix = new Map();
  const below = (prefix: Prefix, step: string) => {
    let child = prefix.get(step);
    if (child === undefined) {
      child = new Map();
      prefix.set(step, child);
    }
    return child;
  };
  return (path: string): Compiled => {
    const known = compiled.get(path);
    if (known) return known;
    const steps: Step[] = [];
    const arrays: Prefix[] = [];
    let fields: Rules['fields'] | undefined = rules.fields;
    let at = root;
    for (const segment of path.split('.')) {
      const name = segment.replace(/(\[\])+$/, '');
      let field: RuleField | undefined = fields?.[name];
      if (field === undefined) throw new Error(`no field at ${path}`);
      at = below(at, name);
      steps.push({ key: name, at, arrays: [...arrays] });
      for (let i = name.length; i < segment.length; i += 2) {
        if (field.type !== 'array') throw new Error(`no array at ${path}`);
        at = below(at, '[]');
        arrays.push(at);
        steps.push({ items: true, at, arrays: [...arrays] });
        field = field.items;
      }
      fields = field.type === 'object' ? field.fields : undefined;
    }
    const result = { steps, arrays };
    compiled.set(path, result);
    return result;
  };
}

type Node = { value: FakeValue; bound: Bound };

/**
 * One step from `nodes`: into a key, or into the items of an array (every
 * item, or only the one `bound` names). Slots when `last`, else nodes.
 * Without `track`, items don't record which item they are (walks below a
 * row need no binding), so nothing is copied per item.
 */
function advance(
  nodes: Node[],
  step: Step,
  bound: Bound,
  last: boolean,
  track = true,
) {
  const found: Slot[] = [];
  const next: Node[] = [];
  for (const node of nodes) {
    const { value } = node;
    if ('key' in step) {
      if (!isContainer(value) || Array.isArray(value)) continue;
      if (last) found.push({ holder: value, key: step.key, bound: node.bound });
      else if (value[step.key] !== undefined) {
        next.push({ value: value[step.key] ?? null, bound: node.bound });
      }
      continue;
    }
    if (!Array.isArray(value)) continue;
    const only = bound.get(step.at);
    const indices =
      only === undefined ? value.keys() : only < value.length ? [only] : [];
    for (const index of indices) {
      const itemBound = track
        ? new Map(node.bound).set(step.at, index)
        : node.bound;
      if (last) found.push({ holder: value, key: index, bound: itemBound });
      else next.push({ value: value[index] ?? null, bound: itemBound });
    }
  }
  return { found, next };
}

const read = (holder: Container, key: string | number) =>
  Array.isArray(holder) ? holder[key as number] : holder[key as string];

function write(holder: Container, key: string | number, value: FakeValue) {
  if (Array.isArray(holder)) holder[key as number] = value;
  else holder[key as string] = value;
}

/** Each distinct path and how often it is listed. */
type Multiset = [Compiled, number][];

class Unprintable extends Error {}

function print(value: Decimal | undefined): number | null {
  if (value === undefined) return null;
  const number = toNumber(value);
  if (number === undefined) throw new Unprintable();
  return number;
}

/**
 * Fills every derived field of `record` in place, in `order`. A field the
 * blank draw left null stays null. Returns the rule-file issues of results
 * that no number prints exactly.
 */
export function fillDerived(
  record: FakeRecord,
  rules: Rules,
  order: DerivedField[],
): Issue[] {
  const compile = compiler(rules);

  // Where a path's values sit: holder and key, for every array item on the
  // way, or only the items `bound` names. The nodes after each step are
  // kept per rule reached and binding, so paths sharing a prefix walk it
  // once (the record's shape doesn't change while derived fields fill).
  const prefixes = new Map<Prefix, Map<string, Node[]>>();
  // Unbound slots are kept per path too: every running balance over the
  // same rows (or field over the same targets) scans them once.
  const unboundSlots = new Map<Compiled, Slot[]>();
  const slots = (path: Compiled, bound: Bound = new Map()): Slot[] => {
    if (bound.size === 0) {
      let known = unboundSlots.get(path);
      if (known === undefined) {
        known = walk(path, bound);
        unboundSlots.set(path, known);
      }
      return known;
    }
    return walk(path, bound);
  };
  const walk = (path: Compiled, bound: Bound): Slot[] => {
    let nodes: Node[] = [{ value: record, bound: new Map() }];
    const { steps } = path;
    for (const step of steps.slice(0, -1)) {
      const key = step.arrays.map(array => bound.get(array) ?? '*').join(',');
      let byBinding = prefixes.get(step.at);
      if (byBinding === undefined) {
        byBinding = new Map();
        prefixes.set(step.at, byBinding);
      }
      const known = byBinding.get(key);
      if (known === undefined) {
        nodes = advance(nodes, step, bound, false).next;
        byBinding.set(key, nodes);
      } else nodes = known;
    }
    return advance(nodes, steps[steps.length - 1] as Step, bound, true).found;
  };
  const multiset = (paths: string[]): Multiset => {
    const counts = new Map<Compiled, number>();
    for (const path of paths) {
      const compiled = compile(path);
      counts.set(compiled, (counts.get(compiled) ?? 0) + 1);
    }
    return [...counts];
  };

  // Each path total is computed once per item of the bound arrays it goes
  // through, so derived fields read each value a bounded number of times.
  // Totals never go stale: a path is read only after the derived fields it
  // reaches are filled.
  const memo = new Map<Compiled, Map<string, Decimal>>();
  const total = (path: Compiled, bound: Bound = new Map()): Decimal => {
    const used = path.arrays.filter(array => bound.has(array));
    const key = used.map(array => bound.get(array)).join(',');
    let byBinding = memo.get(path);
    if (byBinding === undefined) {
      byBinding = new Map();
      memo.set(path, byBinding);
    }
    let sum = byBinding.get(key);
    if (sum === undefined) {
      sum = zero;
      const only = new Map(used.map(array => [array, bound.get(array) ?? 0]));
      for (const { holder, key } of slots(path, only)) {
        const value = read(holder, key);
        if (typeof value === 'number') sum = add(sum, toDecimal(value));
      }
      byBinding.set(key, sum);
    }
    return sum;
  };
  const totals = (paths: Multiset, bound?: Bound) => {
    let sum = zero;
    for (const [path, count] of paths) {
      const { units, scale } = total(path, bound);
      sum = add(sum, { units: units * BigInt(count), scale });
    }
    return sum;
  };

  // Sums and percentages read the same values from every slot: one value.
  const fillOnce = (path: string, value: () => number | null) => {
    const targets = slots(compile(path)).filter(
      ({ holder, key }) => read(holder, key) !== null,
    );
    if (targets.length === 0) return;
    const result = value();
    for (const { holder, key } of targets) write(holder, key, result);
  };

  // The values of `steps` below one row: every item of any array on the
  // way. Every path below the same row, for every running balance, shares
  // its prefixes through that row's `seen`: each row is walked once.
  const unbound: Bound = new Map();
  const rowWalks = new Map<Container, Map<Prefix, Node[]>>();
  const below = (
    row: Slot,
    steps: Step[],
    seen: Map<Prefix, Node[]>,
  ): Slot[] => {
    if (steps.length === 0) return [row];
    let nodes: Node[] = [
      { value: read(row.holder, row.key) ?? null, bound: new Map() },
    ];
    for (const step of steps.slice(0, -1)) {
      const known = seen.get(step.at);
      if (known === undefined) {
        nodes = advance(nodes, step, unbound, false, false).next;
        seen.set(step.at, nodes);
      } else nodes = known;
    }
    return advance(nodes, steps[steps.length - 1] as Step, unbound, true, false)
      .found;
  };
  const sumBelow = (
    row: Slot,
    paths: [Step[], number][],
    seen: Map<Prefix, Node[]>,
  ) => {
    let sum = zero;
    for (const [steps, count] of paths) {
      for (const { holder, key } of below(row, steps, seen)) {
        const value = read(holder, key);
        if (typeof value === 'number') {
          const { units, scale } = toDecimal(value);
          sum = add(sum, { units: units * BigInt(count), scale });
        }
      }
    }
    return sum;
  };

  // Row by row through each rows array. The add, subtract and target paths
  // go through the rows (placement checks that), so they are resolved below
  // the current row; the opening is computed once per rows array, with the
  // arrays around the rows bound to the current item.
  const fillRunning = (
    path: string,
    field: Extract<Derived, { type: 'runningBalance' }>,
  ) => {
    const rows = compile(rowsOf(path) as string);
    const depth = rows.steps.length;
    const relative = (paths: string[]): [Step[], number][] =>
      multiset(paths).map(([compiled, count]) => [
        compiled.steps.slice(depth),
        count,
      ]);
    const target = compile(path).steps.slice(depth);
    const opening = compile(field.opening);
    const adds = relative(field.add);
    const subtracts = relative(field.subtract);
    let holder: Container | undefined;
    let balance = zero;
    for (const row of slots(rows)) {
      if (row.holder !== holder) {
        holder = row.holder;
        balance = total(opening, row.bound);
      }
      if (read(row.holder, row.key) === null) continue;
      const value = read(row.holder, row.key);
      let seen = isContainer(value) ? rowWalks.get(value) : undefined;
      if (seen === undefined) {
        seen = new Map();
        if (isContainer(value)) rowWalks.set(value, seen);
      }
      balance = add(balance, sumBelow(row, adds, seen));
      balance = add(balance, negate(sumBelow(row, subtracts, seen)));
      for (const slot of below(row, target, seen)) {
        if (read(slot.holder, slot.key) !== null) {
          write(slot.holder, slot.key, print(balance));
        }
      }
    }
  };

  const issues: Issue[] = [];
  for (const { path, rulePath, field } of order) {
    try {
      switch (field.type) {
        case 'sum':
          fillOnce(path, () => print(totals(multiset(field.of))));
          break;
        case 'percentage':
          fillOnce(path, () =>
            print(
              percentage(
                total(compile(field.part)),
                total(compile(field.whole)),
                field.decimals,
              ),
            ),
          );
          break;
        case 'runningBalance':
          fillRunning(path, field);
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
