// Test packs that exercise other validation rules still need a printable head.
export function withHead(template: string): string {
  return /<\/head\s*>/i.test(template)
    ? template
    : `<head></head>\n${template}`;
}
