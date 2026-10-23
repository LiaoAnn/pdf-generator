// The template read as HTML, with offsets that are offsets in the template.
import { type DefaultTreeAdapterTypes as Html, parse } from 'parse5';

export type { Html };

export type TemplateHtml = { html: string; document: Html.Document };

/**
 * The template as HTML: Handlebars block tags, `{{else}}` and comments become
 * spaces (newlines kept), so offsets in it are offsets in the template and
 * both branches of every block are checked. Mustaches stay, as text.
 */
function asHtml(source: string, ast: hbs.AST.Program): string {
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
  const visit = (program: hbs.AST.Program | undefined) => {
    for (const statement of program?.body ?? []) {
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
  return html.join('');
}

/** Parses the template as HTML, with source locations. */
export function templateHtml(
  source: string,
  ast: hbs.AST.Program,
): TemplateHtml {
  const html = asHtml(source, ast);
  return { html, document: parse(html, { sourceCodeLocationInfo: true }) };
}

/** An element's attribute by its full name (`xlink:href` included). */
export const attributeOf = (element: Html.Element, name: string) =>
  element.attrs.find(
    attr => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name) === name,
  );
