// Without `<!doctype html>` Chrome prints a template in quirks mode (tables
// fall back to the default 16px text, pages split differently), unlike the
// browser preview its author designed in, so the upload requires it.
import type { PackIssue } from './issues.ts';
import { position } from './text.ts';

// The whitespace the HTML tokenizer skips before a doctype: tab, LF, FF, CR
// and space. Not JavaScript's `\s`: U+00A0 & co. are characters to the HTML
// parser and start the document in quirks mode before the doctype.
const asciiWhitespace = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

// `<!doctype` + ASCII whitespace + `html` + optional ASCII whitespace + `>`.
const doctype = /<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/iy;

/**
 * The pack's template must start with the HTML5 doctype, preceded only by
 * ASCII whitespace, HTML comments (`<!--` … first `-->`) or Handlebars
 * comments. One issue, at the first character that is neither.
 */
export function doctypeIssues(text: string, file: string): PackIssue[] {
  let offset = 0;
  for (;;) {
    while (offset < text.length && asciiWhitespace(text[offset] ?? ''))
      offset += 1;
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4);
      if (end === -1) break;
      offset = end + 3;
      continue;
    }
    if (text.startsWith('{{!--', offset)) {
      const end = text.indexOf('--}}', offset + 5);
      if (end === -1) break;
      offset = end + 4;
      continue;
    }
    if (text.startsWith('{{!', offset)) {
      const end = text.indexOf('}}', offset + 3);
      if (end === -1) break;
      offset = end + 2;
      continue;
    }
    break;
  }
  doctype.lastIndex = offset;
  if (doctype.test(text)) return [];
  return [
    {
      code: 'template-doctype',
      file,
      ...position(text, offset),
      message:
        'the template must start with <!doctype html> (only blank lines and comments may come before it): without it the browser prints the page in quirks mode, which lays the page out differently from the designed preview',
    },
  ];
}
