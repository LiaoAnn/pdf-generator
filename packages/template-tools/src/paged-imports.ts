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

/**
 * For tests only (not exported from the package entry): `visited` grows by
 * one for every rewrite span the offset mapping reads, so a test can tell a
 * linear mapping from one that rescans every earlier span per @import
 * (T06-17), and `walked` grows by one for every node the Sheet.atrules
 * walk enters and every load it reports, so a test can tell the linear
 * walk from one that rewalked every @import's subtree (T06-19). Counting
 * is noise next to the parse.
 */
export const pagedImportWork = { visited: 0, walked: 0 };

/** "element-ident" without its parenthesis. */
const elementIdentLength = 'element-ident'.length;

/**
 * The stylesheets Paged.js 0.4.3's Sheet.parse would fetch for `css`, in
 * fetch order. Never throws: a stylesheet Paged.js can't parse loads
 * nothing, so this returns []. (Sheet.parse also runs replaceUrls, which
 * rewrites url(…) values against the sheet's base URL, before imports; the
 * upload check has no base URL and the loads it rejects are by source path,
 * so this reports the pre-resolution string.) The same string's loads past
 * its `limit`-th are dropped — a string under more than `limit` nested
 * @imports is reported `limit` times; the default reports every load.
 */
export function pagedImports(
  css: string,
  limit = Number.POSITIVE_INFINITY,
): PagedImport[] {
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
  // whose `text` start is at or before the offset; each String is looked
  // up once, however many @imports it sits under (T06-19).
  const originalOffset = (offset: number): number => {
    let lo = -1;
    let hi = rewrites.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      pagedImportWork.visited++;
      if ((rewrites[mid]?.textStart ?? Infinity) <= offset) lo = mid;
      else hi = mid;
    }
    const rewrite = rewrites[lo];
    if (rewrite === undefined) return offset;
    pagedImportWork.visited++;
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

  // Sheet.atrules: every @import in the sheet (nested ones, vendor-prefixed
  // ones — keyword().basename drops the vendor prefix — included) reports
  // the strings of its whole subtree as loads. One walk, where the old walk
  // read each @import's subtree for its media check and again for its
  // strings, so a string under n nested @imports was read n times and the
  // walk cost O(n²) (T06-19): a frame per @import records which loads its
  // subtree added, and the frames that survive are copied out below.
  type Frame = {
    /** The enclosing @import's frame, or null at the top level. */
    parent: Frame | null;
    /** Sheet.imports' media check skips this @import. */
    skip: boolean;
    /** The loads of this @import's subtree: strings[start..end). */
    start: number;
    end: number;
    /** Non-skipped @imports around this one, itself included. */
    depth: number;
  };
  const frames: Frame[] = [];
  /** The open @imports, outermost first. */
  const stack: Frame[] = [];
  /** The open media queries. */
  let mediaQueries = 0;
  /** Every load any open @import would report, in walk order. */
  const strings: PagedImport[] = [];
  csstree.walk(ast, {
    enter: (node: csstree.CssNode) => {
      pagedImportWork.walked++;
      switch (node.type) {
        case 'Atrule': {
          if (csstree.keyword(node.name).basename !== 'import') break;
          const frame: Frame = {
            parent: stack.at(-1) ?? null,
            skip: false,
            start: strings.length,
            end: 0,
            depth: 0,
          };
          frames.push(frame);
          stack.push(frame);
          break;
        }
        case 'MediaQuery':
          mediaQueries++;
          break;
        case 'Identifier': {
          // Sheet.imports' media check, verbatim: a `not`, screen or speech
          // identifier under the @import's media queries skips it (`not`
          // skips even alone; `not screen` skips through the identifier
          // after `not`). Such an identifier's media query sits inside the
          // innermost open @import — a media query can't sit inside an
          // @import — so mark that frame; when it closes, the skip passes
          // to its parent, whose subtree held the media query too.
          if (
            mediaQueries > 0 &&
            (node.name === 'not' ||
              node.name === 'screen' ||
              node.name === 'speech')
          ) {
            const innermost = stack.at(-1);
            if (innermost !== undefined) innermost.skip = true;
          }
          break;
        }
        case 'String': {
          // Sheet.imports: every String under the @import — a quoted URL,
          // the string inside url("…"), a selector replaceIds rewrote — is
          // loaded with its quotes dropped. Its `list.remove(item)` removes
          // the @import from its parent, not the String, and the walk still
          // descends into it: a String under nested @imports loads once for
          // each of them (kept as one entry here — every enclosing
          // @import's frame spans it — and copied out per frame below). A
          // second String under one @import makes that removal throw, after
          // the String was read, and Paged.js then loads nothing from the
          // sheet; this keeps counting, so the upload check errs on more
          // loads.
          if (stack.length > 0 && node.loc !== undefined) {
            strings.push({
              url: node.value.replace(/["']/g, ''),
              offset: originalOffset(node.loc.start.offset) + 1,
            });
          }
          break;
        }
      }
    },
    leave: (node: csstree.CssNode) => {
      if (node.type === 'MediaQuery') {
        mediaQueries--;
      } else if (
        node.type === 'Atrule' &&
        csstree.keyword(node.name).basename === 'import'
      ) {
        const frame = stack.pop() as Frame;
        frame.end = strings.length;
        if (frame.skip && frame.parent !== null) frame.parent.skip = true;
      }
    },
  });

  // Each non-skipped @import reports its subtree's strings, outermost
  // first, up to `limit` of them: a string under more than `limit`
  // non-skipped @imports keeps its first `limit` loads (T06-19).
  const loaded: PagedImport[] = [];
  for (const frame of frames) {
    // Frames were recorded in walk order, so the parent's depth is final.
    frame.depth =
      (frame.parent === null ? 0 : frame.parent.depth) + (frame.skip ? 0 : 1);
    if (frame.skip || frame.depth > limit) continue;
    for (let i = frame.start; i < frame.end; i++) {
      pagedImportWork.walked++;
      loaded.push(strings[i] as PagedImport);
    }
  }
  return loaded;
}
