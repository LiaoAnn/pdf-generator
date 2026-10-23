import type { PageSettings } from './request.ts';

// Only the print Worker's own scripts (the runtime and Paged.js) may run: no
// inline script, event handler attribute or other script source from the
// template. Template code could forge the runtime's check results, and would
// make the output depend on more than the template and its data. The policy
// that holds whatever the template looks like is the response header of
// /blank (public/_headers), which page.setContent keeps; this meta repeats it
// in the document. (puppeteer's page.evaluate is not subject to it.)
const noTemplateScripts = `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`;

/**
 * Turns a template's HTML into the document the print browser loads: a
 * policy that lets only the platform's scripts run, the print runtime and
 * Paged.js go first, and the requested page size is both the first and the
 * last stylesheet of <head>. Paged.js 0.4.3 takes
 * the page box from the first stylesheet that sets a size, but lays the
 * content out with the size of the last one, so both are needed for the
 * request's orientation to win over any `@page { size }` of the template.
 * (Styles inside <body> are not processed as stylesheets by Paged.js.)
 * Relative URLs (`/print-runtime.js`, `/paged.polyfill.js`, `/fonts/…`)
 * resolve against the print Worker, because the page is opened at
 * `<assetOrigin>/blank` before this is set as its content.
 */
export function prepareHtml(
  html: string,
  options: { page: PageSettings },
): string {
  const { size, orientation } = options.page;
  const pageSize = `<style>@page { size: ${size} ${orientation}; }</style>`;
  const first = `${noTemplateScripts}${pageSize}<script src="/print-runtime.js"></script><script src="/paged.polyfill.js"></script>`;
  // Right after the doctype, past any comments and whitespace before it: never
  // before it, which would switch the page to quirks mode.
  const withFirst = insert(html, first, 'after', [
    /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i,
  ]);
  const withLast = insert(withFirst, pageSize, 'before', [
    /<\/head\s*>/i,
    /<body\b/i,
  ]);
  return withLast ?? withFirst.replace(first, () => `${first}${pageSize}`);
}

function insert(
  html: string,
  text: string,
  where: 'after',
  patterns: RegExp[],
): string;
function insert(
  html: string,
  text: string,
  where: 'before',
  patterns: RegExp[],
): string | undefined;
// Inserts at the first match of the first pattern that matches. With no match,
// 'after' puts the text at the start and 'before' returns undefined.
function insert(
  html: string,
  text: string,
  where: 'after' | 'before',
  patterns: RegExp[],
): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const at =
        where === 'after' ? match.index + match[0].length : match.index;
      return `${html.slice(0, at)}${text}${html.slice(at)}`;
    }
  }
  return where === 'after' ? `${text}${html}` : undefined;
}
