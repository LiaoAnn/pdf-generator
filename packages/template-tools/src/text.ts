// Decoding pack text and turning offsets and JSON paths into line/column.
import {
  findNodeAtLocation,
  type JSONPath,
  type ParseError,
  parse as parseLoose,
  parseTree,
} from 'jsonc-parser';
import type { PackIssue } from './issues.ts';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 text without its BOM, or undefined when the bytes aren't UTF-8. */
export function decode(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** 1-based line and column (in UTF-16 code units) of `offset` in `text`. */
function position(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return {
    line: before.split('\n').length,
    column: offset - lineStart + 1,
  };
}

/** Parses JSON, or returns a `json-syntax` issue at the first error. */
export function parseJson(
  text: string,
  file: string,
): { value: unknown } | PackIssue {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    const errors: ParseError[] = [];
    parseLoose(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
    });
    return {
      code: 'json-syntax',
      file,
      ...position(text, errors[0]?.offset ?? 0),
      message: `not valid JSON: ${(error as Error).message}`,
    };
  }
}

/**
 * Where the value at `path` starts in a JSON text; for a path that doesn't
 * exist (a missing key), where its nearest existing ancestor starts.
 */
export function jsonPosition(
  text: string,
  path: (string | number)[],
): { line: number; column: number } {
  const root = parseTree(text);
  if (root === undefined) return { line: 1, column: 1 };
  for (let length = path.length; length >= 0; length--) {
    const node = findNodeAtLocation(root, path.slice(0, length) as JSONPath);
    if (node !== undefined) return position(text, node.offset);
  }
  return position(text, root.offset);
}
