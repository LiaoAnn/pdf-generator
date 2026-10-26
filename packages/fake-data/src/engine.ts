import {
  type RuleField,
  type Rules,
  rulesSchema,
  seedSchema,
} from '@pdf-generator/contract';
import { derivedOrder, fillDerived } from './derived.ts';
import {
  InvalidRecordError,
  InvalidRulesError,
  InvalidSeedError,
  type Issue,
  issuesOf,
} from './errors.ts';
import {
  blankStream,
  indexStream,
  keyHash,
  keyStream,
  type Rng,
  type StreamId,
  seedStream,
  streamRng,
  type WeightTable,
  weightTable,
} from './random.ts';
import { type FakeRecord, type FakeValue, recordSchema } from './schema.ts';
import { address } from './taiwan/address.ts';
import { companyName } from './taiwan/company.ts';
import { businessId, nationalId } from './taiwan/ids.ts';
import { personName } from './taiwan/names.ts';
import { phone } from './taiwan/phone.ts';
import { fillerText, phraseText } from './text.ts';
import { date, decimal, decimalRange, isCalendarDate } from './values.ts';

// Not Extract: the contract types name and nationalId as one variant.
type FieldOf<T extends RuleField['type']> = RuleField & { type: T };

/** Draws one value for a field; `child` generates a nested field by key or index. */
type Generator<T extends RuleField['type']> = (
  field: FieldOf<T>,
  rng: Rng,
  child: (field: RuleField, key: string | number) => FakeValue,
) => FakeValue;

// One table per parsed choice field, so its weights are summed once, not
// once per drawn value.
const weightTables = new WeakMap<FieldOf<'choice'>, WeightTable>();
const weightsOf = (field: FieldOf<'choice'>, weights: number[]) => {
  let table = weightTables.get(field);
  if (table === undefined) {
    table = weightTable(weights);
    weightTables.set(field, table);
  }
  return table;
};

const generators: { [T in RuleField['type']]: Generator<T> } = {
  name: (field, rng) => personName(rng, field.gender),
  nationalId: (field, rng) => nationalId(rng, field.gender),
  businessId: (_field, rng) => businessId(rng),
  company: (_field, rng) => companyName(rng),
  address: (field, rng) => address(rng, field.cities),
  phone: (field, rng) => phone(rng, field.kind),
  date: (field, rng) => date(rng, field.min, field.max),
  money: (field, rng) =>
    decimal(rng, field.min, field.max, field.decimals ?? 0),
  integer: (field, rng) => rng.int(field.min, field.max),
  number: (field, rng) => decimal(rng, field.min, field.max, field.decimals),
  choice: (field, rng) =>
    field.weights
      ? rng.weighted(field.options, weightsOf(field, field.weights))
      : rng.pick(field.options),
  constant: field => field.value,
  object: (field, _rng, child) => generateFields(field.fields, child),
  // Items draw from their own streams, keyed by index, so item k does not
  // depend on the drawn length. Sorting happens here, before fillDerived, so
  // running balances follow the sorted rows.
  array: (field, rng, child) => {
    const items = Array.from(
      { length: rng.int(field.minItems, field.maxItems) },
      (_, i) => child(field.items, i),
    );
    return field.sortBy === undefined ? items : byDate(items, field.sortBy);
  },
  checkbox: (field, rng) => rng.chance(field.probability ?? 0.5),
  text: (field, rng) => {
    const length = rng.int(field.minLength, field.maxLength);
    return field.phrases === undefined
      ? fillerText(rng, field.lang, length)
      : phraseText(rng, field.lang, field.phrases, length);
  },
  // Placeholders: fillDerived computes them once every drawn value exists.
  sum: () => 0,
  runningBalance: () => 0,
  percentage: () => 0,
};

/**
 * Items in ascending order of their `key` date (YYYY-MM-DD compares as text),
 * stable; a blank date or a blank item goes last.
 */
function byDate(items: FakeValue[], key: string): FakeValue[] {
  const dateOf = (item: FakeValue) =>
    (item as FakeRecord | null)?.[key] as string | null | undefined;
  return items.toSorted((a, b) => {
    const [x, y] = [dateOf(a), dateOf(b)];
    if (x == null || y == null)
      return (x == null ? 1 : 0) - (y == null ? 1 : 0);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** Ranges the contract allows but no value satisfies, as rule-file issues. */
function impossible(field: RuleField): Issue[] {
  const at = (key: string, message: string): Issue[] => [
    { path: [key], message },
  ];
  const decimals = (min: number, max: number, places: number): Issue[] => {
    try {
      decimalRange(min, max, places);
      return [];
    } catch (error) {
      return at('min', (error as Error).message);
    }
  };
  switch (field.type) {
    case 'date':
      return [
        ...(isCalendarDate(field.min)
          ? []
          : at('min', `${field.min} is not a calendar date`)),
        ...(isCalendarDate(field.max)
          ? []
          : at('max', `${field.max} is not a calendar date`)),
      ];
    case 'money':
      return decimals(field.min, field.max, field.decimals ?? 0);
    case 'number':
      return decimals(field.min, field.max, field.decimals);
    case 'integer':
      return Number.isSafeInteger(field.max - field.min)
        ? []
        : at('max', 'range is too wide to draw from');
    default:
      return [];
  }
}

/**
 * Every impossible range in the rule file. Its depth, value count and text
 * length were already bounded by the contract's `ruleLimits` when it parsed.
 */
function check(rules: Rules): Issue[] {
  const issues: Issue[] = [];
  const visit = (field: RuleField, rulePath: (string | number)[]) => {
    for (const issue of impossible(field)) {
      issues.push({ ...issue, path: [...rulePath, ...issue.path] });
    }
    if (field.type === 'object') {
      for (const [key, child] of Object.entries(field.fields)) {
        visit(child, [...rulePath, 'fields', key]);
      }
    }
    if (field.type === 'array') visit(field.items, [...rulePath, 'items']);
  };
  for (const [key, field] of Object.entries(rules.fields)) {
    visit(field, ['fields', key]);
  }
  return issues;
}

type Child = (field: RuleField, key: string | number) => FakeValue;

// Keys in rule-file order: JSON objects keep insertion order for these keys
// (they never look like array indices), so the output order is fixed.
function generateFields(fields: Rules['fields'], child: Child): FakeRecord {
  const record: FakeRecord = {};
  for (const [key, field] of Object.entries(fields)) {
    record[key] = child(field, key);
  }
  return record;
}

/**
 * Generates one record from a rule file and a seed. Same rules and seed →
 * the same record, key for key; each field draws from its own stream, derived
 * from its parent's stream and its key or index (e.g. `rows`, 0, `amount`),
 * so adding a field leaves the others unchanged.
 */
export function generate(rules: unknown, seed: string): FakeRecord {
  const parsedRules = rulesSchema.safeParse(rules);
  if (!parsedRules.success) {
    throw new InvalidRulesError(issuesOf(parsedRules.error));
  }
  if (!seedSchema.safeParse(seed).success) {
    throw new InvalidSeedError(
      `invalid seed ${JSON.stringify(seed)}: use 1-64 of A-Z a-z 0-9 _ -`,
    );
  }
  const { order, issues: derivedIssues } = derivedOrder(parsedRules.data);
  const issues = [...check(parsedRules.data), ...derivedIssues];
  if (issues.length > 0) throw new InvalidRulesError(issues);

  // A key's hash is computed once per call, not once per value under it.
  const keyHashes = new Map<string, StreamId>();
  const hashOf = (key: string): StreamId => {
    let hash = keyHashes.get(key);
    if (hash === undefined) {
      hash = keyHash(key);
      keyHashes.set(key, hash);
    }
    return hash;
  };
  const childAt =
    (parent: StreamId): Child =>
    (field, key) => {
      const at =
        typeof key === 'number'
          ? indexStream(parent, key)
          : keyStream(parent, hashOf(key));
      // The blank draw has its own stream, so adding blankProbability leaves
      // the value stream unchanged. A blank object or array generates
      // nothing inside it.
      const blank = field.blankProbability ?? 0;
      if (blank > 0 && streamRng(blankStream(at)).chance(blank)) {
        return null;
      }
      const generator = generators[field.type] as Generator<typeof field.type>;
      return generator(field, streamRng(at), childAt(at));
    };
  const record = generateFields(
    parsedRules.data.fields,
    childAt(seedStream(seed)),
  );
  const unprintable = fillDerived(record, parsedRules.data, order);
  if (unprintable.length > 0) throw new InvalidRulesError(unprintable);

  // jitless, as in workerd (no eval): zod's compiled check of an object with
  // tens of thousands of keys overflows the stack.
  const checked = recordSchema(parsedRules.data).safeParse(record, {
    jitless: true,
  });
  if (!checked.success) throw new InvalidRecordError(issuesOf(checked.error));
  return record;
}
