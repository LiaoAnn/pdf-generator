/**
 * One problem in a template pack, located in the file it is in: a line and
 * column (1-based) for text files, a JSON path for JSON files, or both.
 * The web app also builds PackIssues with its own upload codes, so `code`
 * stays a string; `CheckIssue` is the narrowed form checkPack reports.
 */
export type PackIssue = {
  code: string;
  file: string;
  line?: number;
  column?: number;
  path?: (string | number)[];
  message: string;
};

/**
 * Every code checkPack reports: SPEC.md §9 and skill/references/check-codes.md
 * must explain each one (packages/pack-spec/src/skill.test.ts checks); a new
 * code is added here first.
 */
export const packIssueCodes = [
  'asset-data',
  'asset-dynamic',
  'asset-external',
  'asset-missing',
  'asset-path',
  'asset-stylesheet-type',
  'asset-svg-nested',
  'css-escape',
  'css-import-cycle',
  'css-import-expansion',
  'css-page-box',
  'css-repeating-gradient',
  'file-missing',
  'file-unlisted',
  'font-unused',
  'gt-attribute',
  'gt-branch',
  'gt-checkbox',
  'gt-formula',
  'gt-id',
  'gt-image-text',
  'gt-nested',
  'gt-table',
  'gt-type',
  'gt-unmarked',
  'html-active',
  'html-unsupported',
  'json-syntax',
  'manifest-invalid',
  'manifest-missing',
  'pack-too-complex',
  'pack-too-large',
  'path-invalid',
  'rules-invalid',
  'sample-invalid',
  'template-doctype',
  'template-render',
  'template-structure',
  'template-syntax',
  'template-unknown-field',
  'template-unsupported',
  'text-encoding',
  'zip-invalid',
] as const;

export type PackIssueCode = (typeof packIssueCodes)[number];

/** A PackIssue checkPack reports: the code is always in packIssueCodes. */
export type CheckIssue = PackIssue & { code: PackIssueCode };
