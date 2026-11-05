// For tests only: pagedImports as T06-17 left it (94cfb0c), which walks the
// whole subtree of every @import, so a string under n nested @imports is read
// n times and n nested @import blocks cost O(n²) (T06-19). Kept verbatim but
// for the work counter and the type, as the oracle the one-pass walk in
// paged-imports.ts is compared against (paged-import-counts.test.ts,
// import-counts-check.test.ts).

import csstree from 'css-tree';

/** One load: the URL and the offset just past its quote (or `#`). */
type PagedImport = { url: string; offset: number };

/**
 * The rewrite RunningHeaders.beforeTreeParse applies to the whole text
 * (comments and strings included) before parsing, because CSSTree reads
 * `element(x)` as the non-standard element-reference syntax. Its regex was
 * /element[\s]*\(([^|^#)]*)\)/g; the scanner below makes the same matches.
 */
const elementNameLength = 'element'.length;

/** JavaScript's `\s`: Unicode spaces and line terminators, exactly as `[\s]`. */
const jsSpace = /\s/;

/** Characters that stop an element(…) argument: `|`, `^`, `#` or `)`. */
const argumentStops = '|^#)';

/** One match of the element rewrite: the `e`, its `(` and the `)`. */
type ElementMatch = { start: number; paren: number; close: number };

/**
 * Every match of the element rewrite in `css`, in matchAll order, in
 * linear time. The regex retried each failed start one character later, so
 * every `element(` whose argument runs to a `|`, `^` or `#` (or the end)
 * instead of a `)` was rescanned from every `element` in it, once per
 * opening per stop character — quadratic on such a run. `stopAt`
 * remembers the stop character of the last argument read: a later
 * `element(` inside that argument would run to the same character, so it is
 * reused, not rescanned.
 */
function elementMatches(css: string): ElementMatch[] {
  const matches: ElementMatch[] = [];
  let stopAt = -1;
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf('element', i);
    if (start < 0) break;
    // Each try's whitespace run is its own: no `element` lies inside one.
    let paren = start + elementNameLength;
    while (paren < css.length && jsSpace.test(css[paren] ?? '')) paren++;
    if (css[paren] !== '(') {
      i = start + 1;
      continue;
    }
    const argumentStart = paren + 1;
    let close = argumentStart;
    if (argumentStart <= stopAt) {
      // Everything before stopAt is an argument character.
      close = stopAt;
    } else {
      while (close < css.length && !argumentStops.includes(css[close] ?? ''))
        close++;
      stopAt = close;
    }
    if (css[close] === ')') {
      matches.push({ start, paren, close });
      i = close + 1;
    } else {
      i = start + 1;
    }
  }
  return matches;
}

/** "element-ident" without its parenthesis. */
const elementIdentLength = 'element-ident'.length;

/**
 * The stylesheets Paged.js 0.4.3's Sheet.parse would fetch for `css`, in
 * fetch order. Never throws: a stylesheet Paged.js can't parse loads
 * nothing, so this returns []. (Sheet.parse also runs replaceUrls, which
 * rewrites url(…) values against the sheet's base URL, before imports; the
 * upload check has no base URL and the loads it rejects are by source path,
 * so this reports the pre-resolution string.)
 */
export function fullPagedImports(css: string): PagedImport[] {
  // RunningHeaders.beforeTreeParse rewrites every element(…) to
  // element-ident(…), keeping the argument; record each span so offsets
  // from the parsed text can point back into `css`. Along with each span,
  // record where it starts in `text` and how much the earlier spans shift
  // it (each earlier span is 6 - white characters longer in `text`), so
  // originalOffset below can binary-search the spans instead of rereading
  // every earlier span per @import (T06-17).
  const rewrites: {
    start: number;
    white: number;
    argLength: number;
    textStart: number;
    shift: number;
  }[] = [];
  // The rewritten text, as `css.replace(elementRewrite, 'element-ident($1)')`.
  let text = '';
  let at = 0;
  let shift = 0;
  for (const match of elementMatches(css)) {
    const argument = css.slice(match.paren + 1, match.close);
    const white = match.paren - match.start - elementNameLength;
    rewrites.push({
      start: match.start,
      white,
      argLength: argument.length,
      textStart: match.start + shift,
      shift,
    });
    shift += 6 - white;
    text += `${css.slice(at, match.start)}element-ident(${argument})`;
    at = match.close + 1;
  }
  text += css.slice(at);

  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(text, { positions: true });
  } catch {
    // Sheet.parse rejects; Paged.js loads nothing from the sheet.
    return [];
  }

  // Map an offset in `text` back to `css`, per rewrite: an offset inside
  // `element-ident` is the span's original start, one at or after its `(`
  // is the same character in the original span (the argument is copied
  // verbatim), and one past the span shifts by the length difference
  // ("element-ident(" is 6 longer than "element" + the whitespace + "(").
  // Binary-search the spans (textStart is increasing) for the last span
  // whose `text` start is at or before the offset — a forward cursor would
  // not do, since a string under nested @imports is looked up once per
  // enclosing @import, not in offset order.
  const originalOffset = (offset: number): number => {
    let lo = -1;
    let hi = rewrites.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if ((rewrites[mid]?.textStart ?? Infinity) <= offset) lo = mid;
      else hi = mid;
    }
    const rewrite = rewrites[lo];
    if (rewrite === undefined) return offset;
    const paren = rewrite.textStart + elementIdentLength;
    if (offset < paren) return rewrite.start;
    const spanEnd = paren + 1 + rewrite.argLength + 1;
    if (offset < spanEnd)
      return rewrite.start + 7 + rewrite.white + (offset - paren);
    return offset - (rewrite.shift + 6 - rewrite.white);
  };

  // Sheet.parse's replaceIds turns #id in every rule into
  // [data-id="<id>"], so a selector under @import {…} loads "<id>" as a
  // stylesheet too; Paged.js drops loc, this keeps the #id's so the offset
  // points at it.
  csstree.walk(ast, {
    visit: 'Rule',
    enter: (rule: csstree.Rule) => {
      csstree.walk(rule, {
        visit: 'IdSelector',
        enter: (idSelector: csstree.IdSelector) => {
          const value: csstree.StringNode = {
            type: 'String',
            loc: idSelector.loc,
            value: `"${idSelector.name}"`,
          };
          const attribute = idSelector as unknown as csstree.AttributeSelector;
          attribute.flags = null;
          attribute.matcher = '=';
          attribute.name = { type: 'Identifier', name: 'data-id' };
          attribute.type = 'AttributeSelector';
          attribute.value = value;
        },
      });
    },
  });

  const loaded: PagedImport[] = [];
  // Sheet.atrules: every @import in the sheet (nested ones, vendor-prefixed
  // ones — keyword().basename drops the vendor prefix — included).
  csstree.walk(ast, {
    visit: 'Atrule',
    enter: (atrule: csstree.Atrule) => {
      if (csstree.keyword(atrule.name).basename !== 'import') return;

      // Sheet.imports' media check, verbatim: every identifier under the
      // @import's media queries; screen or speech skips it — including
      // `not screen`, because the identifier after `not` matches.
      const queries: string[] = [];
      csstree.walk(atrule, {
        visit: 'MediaQuery',
        enter: (mediaQuery: csstree.MediaQuery) => {
          csstree.walk(mediaQuery, {
            visit: 'Identifier',
            enter: (identifier: csstree.Identifier) => {
              queries.push(identifier.name);
            },
          });
        },
      });
      if (
        queries.some((query, index) => {
          if (query === 'not') {
            const next = queries[index + 1];
            return !(next === 'screen' || next === 'speech');
          }
          return query === 'screen' || query === 'speech';
        })
      )
        return;

      // Sheet.imports: every String under the @import — a quoted URL, the
      // string inside url("…"), a selector replaceIds rewrote — is loaded
      // with its quotes dropped. Its `list.remove(item)` removes the @import
      // from its parent, not the String, and the walk still descends into
      // it: a String under nested @imports loads once for each of them. A
      // second String under one @import makes that removal throw, after the
      // String was read, and Paged.js then loads nothing from the sheet;
      // this keeps counting, so the upload check errs on more loads.
      csstree.walk(atrule, {
        visit: 'String',
        enter: (urlNode: csstree.StringNode) => {
          if (urlNode.loc === undefined) return;
          loaded.push({
            url: urlNode.value.replace(/["']/g, ''),
            offset: originalOffset(urlNode.loc.start.offset) + 1,
          });
        },
      });
    },
  });

  return loaded;
}
