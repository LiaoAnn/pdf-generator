import {
  type RuleField,
  type Rules,
  rulesSchema,
  seedSchema,
} from '@pdf-generator/contract';
import {
  InvalidRecordError,
  InvalidRulesError,
  InvalidSeedError,
  type Issue,
  issuesOf,
  type Unsupported,
  UnsupportedRuleError,
} from './errors.ts';
import { createRng, type Rng } from './random.ts';
import { type FakeRecord, type FakeValue, recordSchema } from './schema.ts';
import { address } from './taiwan/address.ts';
import { companyName } from './taiwan/company.ts';
import { businessId, nationalId } from './taiwan/ids.ts';
import { personName } from './taiwan/names.ts';
import { phone } from './taiwan/phone.ts';
import { date, decimal, decimalRange, isCalendarDate } from './values.ts';

// Not Extract: the contract types name and nationalId as one variant.
type FieldOf<T extends RuleField['type']> = RuleField & { type: T };

/** Draws one value for a field; `child` generates a nested field by key or index. */
type Generator<T extends RuleField['type']> = (
  field: FieldOf<T>,
  rng: Rng,
  child: (field: RuleField, key: string | number) => FakeValue,
) => FakeValue;

// T12 replaces these with real generators (derived fields also need a pass
// over the finished record) and removes their entries from `unsupported`.
const notYet = (): never => {
  throw new Error('unreachable: unsupported fields are rejected up front');
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
      ? rng.weighted(field.options, field.weights)
      : rng.pick(field.options),
  constant: field => field.value,
  object: (field, _rng, child) => generateFields(field.fields, child),
  // minItems === maxItems until T12 adds row-count ranges.
  array: (field, _rng, child) =>
    Array.from({ length: field.minItems }, (_, i) => child(field.items, i)),
  checkbox: notYet,
  text: notYet,
  sum: notYet,
  runningBalance: notYet,
  percentage: notYet,
};

/** Features of `field` itself that the engine cannot generate yet (T12). */
function unsupported(field: RuleField): string[] {
  const features: string[] = [];
  if ((field.blankProbability ?? 0) > 0) features.push('blank probability');
  switch (field.type) {
    case 'sum':
    case 'runningBalance':
    case 'percentage':
      features.push('derived field');
      break;
    case 'checkbox':
      features.push('random checkbox');
      break;
    case 'text':
      features.push('filler text');
      break;
    case 'array':
      if (field.minItems < field.maxItems) features.push('row-count range');
      break;
  }
  return features;
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

/** How many values `field` generates at most: arrays multiply, objects add. */
function valueCount(field: RuleField): number {
  switch (field.type) {
    case 'object':
      return Object.values(field.fields).reduce(
        (sum, child) => sum + valueCount(child),
        0,
      );
    case 'array':
      return field.maxItems === 0
        ? 0
        : field.maxItems * valueCount(field.items);
    default:
      return 1;
  }
}

/** Every unsupported feature and impossible range in the rule file. */
function check(rules: Rules) {
  const features: Unsupported[] = [];
  const issues: Issue[] = [];
  const visit = (
    field: RuleField,
    recordPath: string,
    rulePath: (string | number)[],
  ) => {
    for (const feature of unsupported(field)) {
      features.push({ path: recordPath, feature });
    }
    for (const issue of impossible(field)) {
      issues.push({ ...issue, path: [...rulePath, ...issue.path] });
    }
    if (field.type === 'object') {
      for (const [key, child] of Object.entries(field.fields)) {
        visit(child, `${recordPath}.${key}`, [...rulePath, 'fields', key]);
      }
    }
    if (field.type === 'array') {
      visit(field.items, `${recordPath}[]`, [...rulePath, 'items']);
    }
  };
  for (const [key, field] of Object.entries(rules.fields)) {
    visit(field, key, ['fields', key]);
  }
  const count = valueCount({ type: 'object', fields: rules.fields });
  if (count > maxValues) {
    issues.push({
      path: ['fields'],
      message: `a record would hold up to ${count} values; the limit is ${maxValues}`,
    });
  }
  return { features, issues };
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
  const { features, issues } = check(parsedRules.data);
  if (features.length > 0) throw new UnsupportedRuleError(features);
  if (issues.length > 0) throw new InvalidRulesError(issues);

  const childAt =
    (path: string): Child =>
    (field, key) => {
      const at = path === '' ? String(key) : `${path}.${key}`;
      const generator = generators[field.type] as Generator<typeof field.type>;
      return generator(field, createRng(seed, at), childAt(at));
    };
  const record = generateFields(parsedRules.data.fields, childAt(''));

  const checked = recordSchema(parsedRules.data).safeParse(record);
  if (!checked.success) throw new InvalidRecordError(issuesOf(checked.error));
  return record;
}
