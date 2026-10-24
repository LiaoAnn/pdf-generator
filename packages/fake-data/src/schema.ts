import type { RuleField, Rules } from '@pdf-generator/contract';
import { z } from 'zod';
import { isValidAddress } from './taiwan/address.ts';
import { isValidBusinessId, isValidNationalId } from './taiwan/ids.ts';
import { isValidPhone } from './taiwan/phone.ts';
import { isCalendarDate } from './values.ts';

/** A value in a generated record. */
export type FakeValue =
  | string
  | number
  | boolean
  | null
  | FakeValue[]
  | { [key: string]: FakeValue };
/** One generated record: field key → value, in rule-file order. */
export type FakeRecord = { [key: string]: FakeValue };

const hasDecimals = (decimals: number) => (value: number) =>
  Number(value.toFixed(decimals)) === value;

const inRange = (min: number, max: number, decimals: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine(hasDecimals(decimals), `at most ${decimals} decimal places`);

const characters = (value: string) => [...value].length;

function valueSchema(field: RuleField): z.ZodType<FakeValue> {
  switch (field.type) {
    case 'name':
      return z.string().regex(/^\p{Script=Han}{2,4}$/u);
    case 'nationalId': {
      const sex = { male: '1', female: '2', any: undefined }[
        field.gender ?? 'any'
      ];
      return z
        .string()
        .refine(isValidNationalId, 'invalid 身分證字號')
        .refine(
          value => sex === undefined || value[1] === sex,
          `gender must be ${field.gender}`,
        );
    }
    case 'businessId':
      return z.string().refine(isValidBusinessId, 'invalid 統一編號');
    case 'company':
      return z.string().regex(/^\p{Script=Han}+有限公司$/u);
    case 'address':
      return z
        .string()
        .refine(
          value => isValidAddress(value, field.cities),
          'invalid address',
        );
    case 'phone':
      return z
        .string()
        .refine(
          value => isValidPhone(value, field.kind),
          `invalid ${field.kind}`,
        );
    case 'date':
      return z
        .string()
        .refine(
          value =>
            isCalendarDate(value) && value >= field.min && value <= field.max,
          `not a date in [${field.min}, ${field.max}]`,
        );
    case 'money':
      return inRange(field.min, field.max, field.decimals ?? 0);
    case 'number':
      return inRange(field.min, field.max, field.decimals);
    case 'integer':
      return z.int().min(field.min).max(field.max);
    case 'choice':
      return z.literal(field.options);
    case 'constant':
      return z.literal(field.value);
    case 'object':
      return fieldsSchema(field.fields);
    case 'array':
      return z
        .array(nullable(field.items))
        .min(field.minItems)
        .max(field.maxItems);
    case 'checkbox':
      return z.boolean();
    case 'text':
      return z
        .string()
        .refine(
          value =>
            characters(value) >= field.minLength &&
            characters(value) <= field.maxLength,
          `length not in [${field.minLength}, ${field.maxLength}]`,
        );
    case 'sum':
    case 'runningBalance':
      return z.number();
    case 'percentage':
      // null when the whole is 0.
      return z.number().nullable();
  }
}

const nullable = (field: RuleField): z.ZodType<FakeValue> =>
  (field.blankProbability ?? 0) > 0
    ? valueSchema(field).nullable()
    : valueSchema(field);

const fieldsSchema = (fields: Rules['fields']) =>
  z.strictObject(
    Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [key, nullable(field)]),
    ),
  ) as z.ZodType<FakeRecord>;

/** zod schema every record generated from `rules` must pass. */
export function recordSchema(rules: Rules): z.ZodType<FakeRecord> {
  return fieldsSchema(rules.fields);
}
