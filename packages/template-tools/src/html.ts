// The template read as HTML, with offsets that are offsets in the template.
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
};

/**
 * The template as HTML: Handlebars block tags, `{{else}}` and comments become
 * spaces (newlines kept), so offsets in it are offsets in the template and
 * both branches of every block are checked. Mustaches stay, as text.
 */
function asHtml(
  source: string,
  ast: hbs.AST.Program,
): { html: string; branches: [number, number][] } {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
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
  const visit = (program: hbs.AST.Program | undefined) => {
    const body = program?.body ?? [];
    const first = body[0];
    const last = body.at(-1);
    if (program !== ast && first && last) {
      branches.push([offset(first.loc.start), offset(last.loc.end)]);
    }
    for (const statement of body) {
      if (
        statement.type === 'ContentStatement' ||
        statement.type === 'MustacheStatement'
      ) {
        keep(statement);
      } else if (statement.type === 'BlockStatement') {
        const block = statement as hbs.AST.BlockStatement;
        visit(block.program);
        visit(block.inverse);
      }
    }
  };
  visit(ast);
  return { html: html.join(''), branches };
}

/** Parses the template as HTML, with source locations. */
export function templateHtml(
  source: string,
  ast: hbs.AST.Program,
): TemplateHtml {
  const { html, branches } = asHtml(source, ast);
  // Branches nest, so the innermost one containing an offset is the
  // shortest; templates have few blocks, so a scan is fine.
  const branchAt = (at: number) => {
    let best = -1;
    branches.forEach(([start, end], i) => {
      const current = branches[best];
      if (
        start <= at &&
        at < end &&
        (current === undefined || end - start < current[1] - current[0])
      ) {
        best = i;
      }
    });
    return best;
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
  };
}

/** An element's attribute by its full name (`xlink:href` included). */
export const attributeOf = (element: Html.Element, name: string) =>
  element.attrs.find(
    attr => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name) === name,
  );
