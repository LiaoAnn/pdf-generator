// The stylesheet loads Paged.js 0.4.3 makes for one stylesheet's text, read
// the way its Sheet.parse reads them — the upload check (checkPack) refuses
// @import cycles and ladders from what it sees, so it must see exactly what
// the print sees, including the forms Chrome's own @import scanner skips
// (T06-9). Each step below names the paged.polyfill.js function it mirrors.

import csstree from 'css-tree';

/** A stylesheet Paged.js 0.4.3 loads for an @import (see the tests). */
export type PagedImport = {
  /**
   * The String node's value with every `"` and `'` dropped — exactly what
   * Sheet.imports passes to `new URL` — so a NUL or tab stays as written.
   */
  url: string;
  /**
   * Offset in the text pagedImports was called with: the first character
   * after the string's opening quote (after `#` for a selector replaceIds
   * rewrote), so a finder can point at what Paged.js would fetch.
   */
  offset: number;
};

/**
 * The rewrite RunningHeaders.beforeTreeParse applies to the whole text
 * (comments and strings included) before parsing, because CSSTree reads
 * `element(x)` as the non-standard element-reference syntax.
 */
const elementRewrite = /element[\s]*\(([^|^#)]*)\)/g;

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
export function pagedImports(css: string): PagedImport[] {
  // RunningHeaders.beforeTreeParse rewrites every element(…) to
  // element-ident(…), keeping the argument; record each span so offsets
  // from the parsed text can point back into `css`.
  const rewrites: { start: number; white: number; argLength: number }[] = [];
  for (const match of css.matchAll(elementRewrite)) {
    const whole = match[0] as string;
    const argument = match[1] as string;
    rewrites.push({
      start: match.index,
      white: whole.length - 'element'.length - argument.length - 2,
      argLength: argument.length,
    });
  }
  const text = css.replace(elementRewrite, 'element-ident($1)');

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
  const originalOffset = (offset: number): number => {
    let shift = 0;
    for (const rewrite of rewrites) {
      const start = rewrite.start + shift;
      if (offset < start) break;
      const paren = start + elementIdentLength;
      if (offset < paren) return rewrite.start;
      const spanEnd = paren + 1 + rewrite.argLength + 1;
      if (offset < spanEnd)
        return rewrite.start + 7 + rewrite.white + (offset - paren);
      shift += 6 - rewrite.white;
    }
    return offset - shift;
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
