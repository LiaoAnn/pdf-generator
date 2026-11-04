// Counting the work scanCss does, for tests that would otherwise time it: a
// stylesheet's scan must stay linear in its length (T06-15). The count is
// what scanCss reports through `cssWork` (the characters handed to it and
// the ones its own loops read) plus the characters each String and RegExp
// builtin touches while a scan runs, so a scan that copies or searches the
// rest of the text at each step (T09-7's `css.slice(i).split('')`) counts
// quadratic too. Backtracking inside one regex call is invisible to any
// count: those shapes stay timed (svg-assets.test.ts, linear-regex.test.ts).
import { cssWork } from './css.ts';

/** What `countCssWork` counted while its callback ran. */
export type CssWork = {
  /** Characters of CSS handed to scanCss. */
  scanned: number;
  /** Characters scanCss's own loops read. */
  read: number;
  /** Characters String and RegExp builtins touched during a scan. */
  builtins: number;
};

type Method = (this: unknown, ...args: unknown[]) => unknown;

const lengthOf = (value: unknown) =>
  typeof value === 'string' ? value.length : 1;

/** Characters a String method touches: what it returns, or all of `text`. */
const stringCosts: Record<
  string,
  (text: string, args: unknown[], result: unknown) => number
> = {
  ...Object.fromEntries(
    [
      'slice',
      'substring',
      'substr',
      'at',
      'charAt',
      'charCodeAt',
      'codePointAt',
      'toLowerCase',
      'toUpperCase',
      'toLocaleLowerCase',
      'toLocaleUpperCase',
      'trim',
      'trimStart',
      'trimEnd',
      'normalize',
      'padStart',
      'padEnd',
      'repeat',
      'concat',
    ].map(name => [
      name,
      (_: string, __: unknown[], result: unknown) => lengthOf(result),
    ]),
  ),
  ...Object.fromEntries(
    [
      'split',
      'match',
      'matchAll',
      'replace',
      'replaceAll',
      'search',
      'includes',
      'lastIndexOf',
      'localeCompare',
    ].map(name => [name, (text: string) => text.length]),
  ),
  // From where the search starts to where it found the text, or the end.
  indexOf: (text, args, result) => {
    const from = Math.min(Math.max(Number(args[1]) || 0, 0), text.length);
    const found = result as number;
    return found < 0
      ? text.length - from
      : found - from + String(args[0]).length;
  },
  startsWith: (_, args) => String(args[0]).length,
  endsWith: (_, args) => String(args[0]).length,
};

/**
 * Wraps the builtins to add what they touch to `work.builtins` while a scan
 * runs (`cssWork.scanning`); the returned function puts them back.
 */
function install(work: CssWork): () => void {
  const restores: (() => void)[] = [];
  const wrap = (
    target: object,
    key: string | symbol,
    make: (original: Method) => Method,
  ) => {
    const original = Reflect.get(target, key) as Method;
    Reflect.set(target, key, make(original));
    restores.push(() => Reflect.set(target, key, original));
  };
  for (const [name, cost] of Object.entries(stringCosts)) {
    wrap(
      String.prototype,
      name,
      original =>
        function (this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          if (cssWork.scanning > 0) {
            work.builtins += cost(String(this), args, result);
          }
          return result;
        },
    );
  }
  wrap(
    String.prototype,
    Symbol.iterator,
    original =>
      function (this: unknown, ...args: unknown[]) {
        if (cssWork.scanning > 0) work.builtins += String(this).length;
        return original.apply(this, args);
      },
  );
  // test, match, replace, split and search all call exec (with a patched
  // exec they take the spec's slow path, which looks it up each time).
  wrap(
    RegExp.prototype,
    'exec',
    original =>
      function (this: unknown, ...args: unknown[]) {
        const regex = this as RegExp;
        const text = String(args[0]);
        const from = regex.global || regex.sticky ? regex.lastIndex : 0;
        const result = original.apply(this, args) as RegExpExecArray | null;
        if (cssWork.scanning > 0) {
          work.builtins += Math.max(
            1,
            result
              ? result.index + result[0].length - from
              : regex.sticky
                ? 1
                : text.length - from,
          );
        }
        return result;
      },
  );
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

/**
 * Runs `run` with the builtins wrapped and returns what scans did meanwhile.
 * Synchronous only: anything else that scans CSS meanwhile is counted too.
 */
export function countCssWork<T>(run: () => T): { result: T; work: CssWork } {
  const work: CssWork = { scanned: 0, read: 0, builtins: 0 };
  const before = { scanned: cssWork.scanned, read: cssWork.read };
  const restore = install(work);
  try {
    const result = run();
    work.scanned = cssWork.scanned - before.scanned;
    work.read = cssWork.read - before.read;
    return { result, work };
  } finally {
    restore();
  }
}

/** Everything a scan's count adds up to, per character scanned. */
export const perCharacter = (work: CssWork) =>
  (work.read + work.builtins) / work.scanned;
