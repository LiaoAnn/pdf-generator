// Fills a template with a record. STUB until T06 merges its eval-free
// Handlebars fill (Handlebars.compile throws in workerd): this one knows only
// `{{path.to.value}}` and throws on any other mustache, so a template that
// needs more fails loudly instead of printing wrong text.
import type { FakeRecord, FakeValue } from '@pdf-generator/fake-data';

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function fill(template: string, record: FakeRecord): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (_, expression: string) => {
    const path = expression.trim();
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path)) {
      throw new Error(`fill stub: unsupported mustache {{${expression}}}`);
    }
    let value: FakeValue | undefined = record;
    for (const key of path.split('.')) {
      value =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? value[key]
          : undefined;
    }
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new Error(`fill stub: {{${path}}} is not a value in the record`);
    }
    return String(value).replace(/[&<>"']/g, c => escapes[c] ?? c);
  });
}
