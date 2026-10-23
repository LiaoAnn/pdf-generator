// Seeded fake-data engine with valid Taiwanese identifiers (T05); derived
// fields, row-count ranges, blanks, checkboxes and filler text come in T12.
export { generate } from './engine.ts';
export {
  InvalidRecordError,
  InvalidRulesError,
  InvalidSeedError,
  type Issue,
  type Unsupported,
  UnsupportedRuleError,
} from './errors.ts';
export { type FakeRecord, type FakeValue, recordSchema } from './schema.ts';
export { isValidAddress } from './taiwan/address.ts';
export { isValidBusinessId, isValidNationalId } from './taiwan/ids.ts';
export { isValidPhone } from './taiwan/phone.ts';
export { isCalendarDate } from './values.ts';
