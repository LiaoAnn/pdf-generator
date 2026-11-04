// Test packs that exercise other validation rules still need a printable
// document: the HTML5 doctype first (template-doctype) and a head. The doctype
// goes on the template's first line, so the lines of its issues don't move.
export function withHead(template: string): string {
  const [, doctype = '<!doctype html>', rest = ''] =
    /^(<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>)?([\s\S]*)$/i.exec(template) ??
    [];
  return /<\/head\s*>/i.test(rest)
    ? `${doctype}${rest}`
    : `${doctype}<head></head>\n${rest}`;
}
