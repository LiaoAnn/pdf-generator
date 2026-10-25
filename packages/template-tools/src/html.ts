// The template read as HTML, with offsets that are offsets in the template.
import { decodeHTMLAttribute } from 'entities';
import { type DefaultTreeAdapterTypes as Html, parse } from 'parse5';

export type { Html };

export type TemplateHtml = {
  html: string;
  document: Html.Document;
  /**
   * Which Handlebars branch an offset is in: the part of a block before or
   * after its `{{else}}`; -1 outside every block. Two offsets in the same
   * branch are always printed together, or not at all.
   */
  branchAt: (offset: number) => number;
  /** Whether an offset lies in a branch or in a branch nested inside it. */
  inBranch: (offset: number, branch: number) => boolean;
  /** Every Handlebars tag (`{{…}}`) in the template, in source order. */
  statements: Statement[];
  /**
   * How many of the things at `items` (offsets inside the element starting
   * at `container`) the filled template can print: the fewest and the most
   * over every way its blocks can go (Infinity: an `{{#each}}` repeats one).
   */
  printedCount: (
    container: number,
    items: number[],
  ) => { min: number; max: number };
};

/** A branch's block, by number, and whether it is the block's `{{else}}` part. */
type BranchOf = { block: number; helper: string; inverse: boolean };

/** One Handlebars tag: [start, end) offsets, and whether it prints a value. */
type Statement = { start: number; end: number; mustache: boolean };

/**
 * The template as HTML: Handlebars block tags, `{{else}}` and comments become
 * spaces (newlines kept), so offsets in it are offsets in the template and
 * both branches of every block are checked. Mustaches stay, as text.
 */
function asHtml(
  source: string,
  ast: hbs.AST.Program,
): {
  html: string;
  branches: [number, number][];
  owners: BranchOf[];
  statements: Statement[];
} {
  // Lines as Handlebars' lexer counts them: CR LF, CR and LF each end one.
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n' || (source[i] === '\r' && source[i + 1] !== '\n')) {
      lineStarts.push(i + 1);
    }
  }
  const offset = ({ line, column }: hbs.AST.Position) =>
    (lineStarts[line - 1] ?? 0) + column;
  const html = source.replace(/[^\n]/g, ' ').split('');
  const keep = (node: hbs.AST.Node) => {
    const start = offset(node.loc.start);
    const end = offset(node.loc.end);
    for (let i = start; i < end; i++) html[i] = source[i] ?? ' ';
  };
  const branches: [number, number][] = [];
  const owners: BranchOf[] = [];
  let blocks = 0;
  const content: [number, number][] = [];
  // Mustaches and comments, whose exact extent the AST knows (a comment can
  // contain `}}`), by start offset.
  const known = new Map<number, Statement>();
  const record = (node: hbs.AST.Node, mustache: boolean) => {
    const start = offset(node.loc.start);
    known.set(start, { start, end: offset(node.loc.end), mustache });
  };
  const visit = (program: hbs.AST.Program | undefined, owner?: BranchOf) => {
    const body = program?.body ?? [];
    const first = body[0];
    const last = body.at(-1);
    if (owner && first && last) {
      branches.push([offset(first.loc.start), offset(last.loc.end)]);
      owners.push(owner);
    }
    for (const statement of body) {
      if (statement.type === 'ContentStatement') {
        content.push([offset(statement.loc.start), offset(statement.loc.end)]);
        keep(statement);
      } else if (statement.type === 'MustacheStatement') {
        keep(statement);
        record(statement, true);
      } else if (statement.type === 'CommentStatement') {
        record(statement, false);
      } else if (statement.type === 'BlockStatement') {
        const block = statement as hbs.AST.BlockStatement;
        const number = blocks++;
        const helper = (block.path as hbs.AST.PathExpression).original;
        visit(block.program, { block: number, helper, inverse: false });
        visit(block.inverse, { block: number, helper, inverse: true });
      }
    }
  };
  visit(ast);
  // Whatever isn't content is Handlebars: mustaches, comments and block tags
  // ({{else}} has no node of its own), split at each `{{`.
  content.sort((a, b) => a[0] - b[0]);
  const statements: Statement[] = [];
  let at = 0;
  const ends: [number, number][] = [...content, [source.length, source.length]];
  for (const [start, end] of ends) {
    const gap = source.slice(at, start);
    for (let i = gap.indexOf('{{'); i >= 0; ) {
      const statement = known.get(at + i) ?? {
        start: at + i,
        end: at + i + blockTagLength(gap.slice(i)),
        mustache: false,
      };
      statements.push(statement);
      i = gap.indexOf('{{', statement.end - at);
    }
    at = end;
  }
  return { html: html.join(''), branches, owners, statements };
}

/**
 * Length of the block tag ({{#…}}, {{else}}, {{/…}}) starting `text`: up to
 * the first `}}` outside a string literal (`"…"` or `'…'`, `\` escaping a
 * quote, as Handlebars' lexer reads them).
 */
function blockTagLength(text: string): number {
  let quote: string | undefined;
  for (let i = 2; i < text.length; i++) {
    const c = text[i];
    if (quote !== undefined) {
      if (c === '\\' && text[i + 1] === quote) i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '}' && text[i + 1] === '}') return i + 2;
  }
  return text.length;
}

/** Parses the template as HTML, with source locations. */
export function templateHtml(
  source: string,
  ast: hbs.AST.Program,
): TemplateHtml {
  const { html, branches, owners, statements } = asHtml(source, ast);
  // Branches nest. Sorted by start, each one's parent is the nearest earlier
  // branch that contains it; the innermost branch containing an offset is
  // then the last one starting at or before it, or one of its ancestors.
  const order = branches
    .map((range, i) => ({ range, i }))
    .sort((a, b) => a.range[0] - b.range[0]);
  const parents: number[] = [];
  const open: number[] = [];
  order.forEach(({ range }, k) => {
    while (open.length > 0) {
      const top = order[open.at(-1) ?? 0]?.range ?? [0, 0];
      if (range[0] < top[1]) break;
      open.pop();
    }
    parents.push(open.at(-1) ?? -1);
    open.push(k);
  });
  const branchAt = (at: number) => {
    let low = 0;
    let high = order.length - 1;
    let k = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((order[middle]?.range[0] ?? 0) <= at) {
        k = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    for (; k >= 0; k = parents[k] ?? -1) {
      const entry = order[k];
      if (entry && at < entry.range[1]) return entry.i;
    }
    return -1;
  };
  const inBranch = (at: number, branch: number) => {
    const range = branches[branch];
    return range === undefined || (range[0] <= at && at < range[1]);
  };
  const parentOf: number[] = [];
  order.forEach(({ i }, k) => {
    parentOf[i] = order[parents[k] ?? -1]?.i ?? -1;
  });
  const printedCount = (container: number, items: number[]) => {
    const root = branchAt(container);
    // The items directly in each branch, the blocks directly in each branch
    // that hold an item, and each such block's branches that hold one.
    const direct = new Map<number, number>();
    const inner = new Map<number, Set<number>>();
    const parts = new Map<number, Set<number>>();
    const add = (map: Map<number, Set<number>>, key: number, value: number) =>
      map.set(key, (map.get(key) ?? new Set()).add(value));
    for (const at of items) {
      let branch = branchAt(at);
      direct.set(branch, (direct.get(branch) ?? 0) + 1);
      for (; branch !== root && branch >= 0; branch = parentOf[branch] ?? -1) {
        const block = owners[branch]?.block ?? -1;
        add(inner, parentOf[branch] ?? -1, block);
        add(parts, block, branch);
      }
    }
    const none = { min: 0, max: 0 };
    const inBranchCount = (branch: number): { min: number; max: number } => {
      let min = direct.get(branch) ?? 0;
      let max = min;
      for (const block of inner.get(branch) ?? []) {
        const count = inBlockCount(block);
        min += count.min;
        max += count.max;
      }
      return { min, max };
    };
    const inBlockCount = (block: number) => {
      let printed = none;
      let otherwise = none;
      let helper = '';
      for (const branch of parts.get(block) ?? []) {
        const owner = owners[branch];
        helper = owner?.helper ?? '';
        if (owner?.inverse) otherwise = inBranchCount(branch);
        else printed = inBranchCount(branch);
      }
      // if, unless and with print one of their two parts; each prints its
      // {{else}} part for an empty list, else its body once per item.
      const min = Math.min(printed.min, otherwise.min);
      if (helper === 'each') {
        return { min, max: printed.max > 0 ? Infinity : otherwise.max };
      }
      return { min, max: Math.max(printed.max, otherwise.max) };
    };
    return inBranchCount(root);
  };
  return {
    html,
    document: parse(html, { sourceCodeLocationInfo: true }),
    branchAt,
    inBranch,
    statements,
    printedCount,
  };
}

/** The document's `<head>` and `<html>` elements, as the parser built them. */
export function headOf(document: Html.Document): {
  html?: Html.Element;
  head?: Html.Element;
} {
  const html = document.childNodes.find(
    (node): node is Html.Element =>
      'tagName' in node && node.tagName === 'html',
  );
  const head = html?.childNodes.find(
    (node): node is Html.Element =>
      'tagName' in node && node.tagName === 'head',
  );
  return { html, head };
}

/**
 * Where the head's end tag (`</head>`, `</head >`, `</HEAD>`) starts in an
 * HTML document, as the browser's parser reads it (not in a comment or the
 * title); undefined when the head has no explicit end tag.
 */
export function headEnd(html: string): number | undefined {
  const { head } = headOf(parse(html, { sourceCodeLocationInfo: true }));
  return head?.sourceCodeLocation?.endTag?.startOffset;
}

/** An element's attribute by its full name (`xlink:href` included). */
export const attributeOf = (element: Html.Element, name: string) =>
  element.attrs.find(
    attr => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name) === name,
  );

/** Every node inside `node`, in document order. */
export function* descendants(node: Html.ParentNode): Generator<Html.ChildNode> {
  for (const child of node.childNodes) {
    yield child;
    if ('childNodes' in child) yield* descendants(child);
  }
}

/** Offset of the last printed thing inside an element, if any. */
export function lastContent(
  html: string,
  element: Html.Element,
): number | undefined {
  let last: number | undefined;
  for (const node of descendants(element)) {
    const location = node.sourceCodeLocation;
    if (!location) continue;
    if (node.nodeName === '#text') {
      const slice = html.slice(location.startOffset, location.endOffset);
      const trailing = /\S\s*$/.exec(slice);
      if (trailing) last = location.startOffset + trailing.index;
    } else if ('tagName' in node) last = location.startOffset;
  }
  return last;
}

/**
 * An attribute value as the browser reads it (entities decoded, CR LF and CR
 * as LF), with, for each offset in it, the offset in the raw value.
 */
export function decodedOffsets(raw: string): {
  decoded: string;
  raw: number[];
} {
  let decoded = '';
  const offsets: number[] = [];
  for (const token of raw.matchAll(
    /\r\n?|&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);?|[\s\S]/g,
  )) {
    const text = token[0].startsWith('\r')
      ? '\n'
      : token[0].startsWith('&')
        ? decodeHTMLAttribute(token[0])
        : token[0];
    for (let i = 0; i < text.length; i++) offsets.push(token.index);
    decoded += text;
  }
  offsets.push(raw.length);
  return { decoded, raw: offsets };
}
