// The issue codes apps/web's template upload reports, kept in one place so
// the pack spec and the upload page's explanations can each require every
// one of them.
import type { PackIssue } from '@pdf-generator/template-tools';

/**
 * Every code the web upload itself reports (unzip.ts, limits.ts, and
 * api/templates.ts when checkPack throws): SPEC.md §9 and
 * packages/pack-spec/skill/references/check-codes.md must explain each one
 * (packages/pack-spec/src/skill.test.ts checks), and explain.ts needs a
 * Chinese explanation for each (explain.test.ts checks); a new code is added
 * here first. `zip-invalid` and `pack-too-large` are checkPack codes too
 * (packages/template-tools/src/issues.ts `packIssueCodes`).
 */
export const uploadIssueCodes = [
  'file-too-large',
  'pack-check-failed',
  'pack-text-too-large',
  'pack-too-large',
  'pack-too-many-files',
  'zip-duplicate-name',
  'zip-invalid',
  'zip-too-many-blocks',
] as const;

export type UploadIssueCode = (typeof uploadIssueCodes)[number];

/** A PackIssue the web upload reports: its code is always in uploadIssueCodes. */
export type UploadIssue = PackIssue & { code: UploadIssueCode };
