import type { PageSettings } from './request.ts';

/**
 * Turns a template's HTML into the document the print browser loads: the
 * print runtime and Paged.js go first in <head>, and the requested page size
 * is both the first and the last stylesheet of <head>. Paged.js 0.4.3 takes
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
  const first = `${pageSize}<script src="/print-runtime.js"></script><script src="/paged.polyfill.js"></script>`;
  // Never before the doctype: a script there would switch to quirks mode.
  const withFirst = insert(html, first, 'after', [
    /<head\b[^>]*>/i,
    /<html\b[^>]*>/i,
    /<!doctype[^>]*>/i,
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
