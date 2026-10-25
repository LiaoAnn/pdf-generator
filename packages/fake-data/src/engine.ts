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
import { createRng, type Rng } from './random.ts';
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
      ? rng.weighted(field.options, field.weights)
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

/** The most values one record may hold, so a small rule file cannot exhaust a Worker. */
const maxValues = 100_000;

/** How deep fields may nest (a root field is level 1), so a path stays short to walk. */
const maxLevels = 32;

/** The most filler-text characters one record may hold. */
const maxTextCharacters = 1_000_000;

/** How many of something `field` generates at most: arrays multiply, objects add. */
function worstCase(
  field: RuleField,
  leaf: (field: RuleField) => number,
): number {
  switch (field.type) {
    case 'object':
      return Object.values(field.fields).reduce(
        (sum, child) => sum + worstCase(child, leaf),
        0,
      );
    case 'array':
      return field.maxItems === 0
        ? 0
        : field.maxItems * worstCase(field.items, leaf);
    default:
      return leaf(field);
  }
}

/** Every impossible range in the rule file, and a record too deep, large or long. */
function check(rules: Rules): Issue[] {
  const issues: Issue[] = [];
  const visit = (
    field: RuleField,
    rulePath: (string | number)[],
    level: number,
  ) => {
    if (level > maxLevels) {
      issues.push({
        path: rulePath,
        message: `fields nest ${level} levels deep; the limit is ${maxLevels}`,
      });
      return;
    }
    for (const issue of impossible(field)) {
      issues.push({ ...issue, path: [...rulePath, ...issue.path] });
    }
    if (field.type === 'object') {
      for (const [key, child] of Object.entries(field.fields)) {
        visit(child, [...rulePath, 'fields', key], level + 1);
      }
    }
    if (field.type === 'array') {
      visit(field.items, [...rulePath, 'items'], level + 1);
    }
  };
  for (const [key, field] of Object.entries(rules.fields)) {
    visit(field, ['fields', key], 1);
  }
  const record: RuleField = { type: 'object', fields: rules.fields };
  const count = worstCase(record, () => 1);
  if (count > maxValues) {
    issues.push({
      path: ['fields'],
      message: `a record would hold up to ${count} values; the limit is ${maxValues}`,
    });
  }
  const characters = worstCase(record, field =>
    field.type === 'text' ? field.maxLength : 0,
  );
  if (characters > maxTextCharacters) {
    issues.push({
      path: ['fields'],
      message: `a record would hold up to ${characters} characters of filler text; the limit is ${maxTextCharacters}`,
    });
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
 * the same record, key for key; each field draws from its own stream, keyed
 * by its path in the record (e.g. `rows.0.amount`), so adding a field leaves
 * the others unchanged.
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

  const childAt =
    (path: string): Child =>
    (field, key) => {
      const at = path === '' ? String(key) : `${path}.${key}`;
      // The blank draw has its own stream (`?` never occurs in a key), so
      // adding blankProbability leaves the value stream unchanged. A blank
      // object or array generates nothing inside it.
      const blank = field.blankProbability ?? 0;
      if (blank > 0 && createRng(seed, `${at}?blank`).chance(blank)) {
        return null;
      }
      const generator = generators[field.type] as Generator<typeof field.type>;
      return generator(field, createRng(seed, at), childAt(at));
    };
  const record = generateFields(parsedRules.data.fields, childAt(''));
  const unprintable = fillDerived(record, parsedRules.data, order);
  if (unprintable.length > 0) throw new InvalidRulesError(unprintable);

  const checked = recordSchema(parsedRules.data).safeParse(record);
  if (!checked.success) throw new InvalidRecordError(issuesOf(checked.error));
  return record;
}
