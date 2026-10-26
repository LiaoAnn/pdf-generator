import { z } from 'zod';

// Patterns across the contract end in `(?![\s\S])`, not `$`: Python's `$`
// also matches before a trailing newline, so Python consumers of the JSON
// Schema would accept `"asset.css\n"`. For the same reason they use `[0-9]`,
// not `\d` (Python's also matches full-width digits), and `[\s\S]`, not `.`
// (JS's skips line separators such as U+2028).

/** Lower-case kebab-case identifier, e.g. `company-monthly-report`. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/)
  .describe('Lower-case kebab-case identifier, e.g. `company-monthly-report`.');

// One path segment: no slash, backslash or control character.
const segment = String.raw`[^/\\\u0000-\u001f\u007f]+`;

/** A POSIX path relative to the template pack root that cannot leave it. */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    new RegExp(
      String.raw`^(?!(?:[\s\S]*/)?\.{1,2}(?:/|(?![\s\S])))(?:${segment}/)*${segment}(?![\s\S])`,
    ),
  )
  .describe(
    "Path relative to the template pack root, '/'-separated, with no leading '/', empty, '.' or '..' segment, backslash or control character.",
  );

/** Seed that makes fake data and a whole batch reproducible. */
export const seedSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}(?![\s\S])/)
  .describe('Seed: 1-64 of A-Z a-z 0-9 _ -.');
