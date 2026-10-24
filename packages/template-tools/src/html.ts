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
};

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
  const content: [number, number][] = [];
  // Mustaches and comments, whose exact extent the AST knows (a comment can
  // contain `}}`), by start offset.
  const known = new Map<number, Statement>();
  const record = (node: hbs.AST.Node, mustache: boolean) => {
    const start = offset(node.loc.start);
    known.set(start, { start, end: offset(node.loc.end), mustache });
  };
  const visit = (program: hbs.AST.Program | undefined) => {
    const body = program?.body ?? [];
    const first = body[0];
    const last = body.at(-1);
    if (program !== ast && first && last) {
      branches.push([offset(first.loc.start), offset(last.loc.end)]);
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
        visit(block.program);
        visit(block.inverse);
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
  return { html: html.join(''), branches, statements };
}

/** Length of the block tag ({{#…}}, {{else}}, {{/…}}) starting `text`. */
function blockTagLength(text: string): number {
  const end = text.indexOf('}}');
  return end < 0 ? text.length : end + 2;
}

/** Parses the template as HTML, with source locations. */
export function templateHtml(
  source: string,
  ast: hbs.AST.Program,
): TemplateHtml {
  const { html, branches, statements } = asHtml(source, ast);
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
  return {
    html,
    document: parse(html, { sourceCodeLocationInfo: true }),
    branchAt,
    inBranch,
    statements,
  };
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
