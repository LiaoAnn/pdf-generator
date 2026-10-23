import type { z } from 'zod';

/** Where a problem is, as a path into the rule file or the record, and what it is. */
export type Issue = { path: (string | number)[]; message: string };

export const issuesOf = (error: z.ZodError): Issue[] =>
  error.issues.map(issue => ({
    path: issue.path.map(key => (typeof key === 'symbol' ? String(key) : key)),
    message: issue.message,
  }));

const describe = (issues: Issue[]) =>
  issues
    .map(({ path, message }) => `${path.join('.') || '(root)'}: ${message}`)
    .join('; ');

/** The rule file fails the contract, or asks for a value no record can have. */
export class InvalidRulesError extends Error {
  override readonly name = 'InvalidRulesError';
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`invalid rule file: ${describe(issues)}`);
    this.issues = issues;
  }
}

/** The seed fails the contract's seed format. */
export class InvalidSeedError extends Error {
  override readonly name = 'InvalidSeedError';
}

/** A field the rule file allows but the engine cannot generate yet. */
export type Unsupported = { path: string; feature: string };

/** The rule file is valid but uses features ticket T12 adds. */
export class UnsupportedRuleError extends Error {
  override readonly name = 'UnsupportedRuleError';
  readonly ticket = 'T12';
  readonly unsupported: Unsupported[];
  constructor(unsupported: Unsupported[]) {
    super(
      `not supported yet (T12): ${unsupported
        .map(({ path, feature }) => `${path} (${feature})`)
        .join(', ')}`,
    );
    this.unsupported = unsupported;
  }
}

/** A generated record failed its own schema: an engine bug. */
export class InvalidRecordError extends Error {
  override readonly name = 'InvalidRecordError';
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`generated record is invalid: ${describe(issues)}`);
    this.issues = issues;
  }
}
