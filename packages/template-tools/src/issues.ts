/**
 * One problem in a template pack, located in the file it is in: a line and
 * column (1-based) for text files, a JSON path for JSON files, or both.
 */
export type PackIssue = {
  code: string;
  file: string;
  line?: number;
  column?: number;
  path?: (string | number)[];
  message: string;
};
