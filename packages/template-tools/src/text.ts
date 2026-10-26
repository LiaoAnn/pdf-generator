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

// Line starts of the text most recently asked about: issues come in runs
// for one file, so this keeps locating thousands of them linear.
let cached: { text: string; starts: number[] } | undefined;

/** 1-based line and column (in UTF-16 code units) of `offset` in `text`. */
export function position(
  text: string,
  offset: number,
): { line: number; column: number } {
  if (cached?.text !== text) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
      starts.push(i + 1);
    }
    cached = { text, starts };
  }
  const { starts } = cached;
  // The last line start at or before offset.
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
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

// The tree of the JSON text most recently located in, for the same reason.
let cachedTree:
  | { text: string; root: ReturnType<typeof parseTree> }
  | undefined;

/**
 * Where the value at `path` starts in a JSON text; for a path that doesn't
 * exist (a missing key), where its nearest existing ancestor starts. No
 * position for a text nested too deeply to parse.
 */
export function jsonPosition(
  text: string,
  path: (string | number)[],
): { line?: number; column?: number } {
  if (cachedTree?.text !== text) {
    try {
      cachedTree = { text, root: parseTree(text) };
    } catch (error) {
      // parseTree recurses: deep nesting overflows the stack.
      if (!(error instanceof RangeError)) throw error;
      return {};
    }
  }
  const { root } = cachedTree;
  if (root === undefined) return { line: 1, column: 1 };
  for (let length = path.length; length >= 0; length--) {
    const node = findNodeAtLocation(root, path.slice(0, length) as JSONPath);
    if (node !== undefined) return position(text, node.offset);
  }
  return position(text, root.offset);
}
