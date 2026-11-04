// Without `<!doctype html>` Chrome prints a template in quirks mode (tables
// fall back to the default 16px text, pages split differently), unlike the
// browser preview its author designed in, so the upload requires it.
import type { PackIssue } from './issues.ts';
import { position } from './text.ts';

// What may come before the doctype, one piece at a time:
// - the whitespace the HTML tokenizer skips there: tab, LF, FF, CR and space.
//   Not JavaScript's `\s`: U+00A0 & co. are characters to the HTML parser and
//   start the document in quirks mode before the doctype;
// - an HTML comment, ending where the tokenizer ends it: `<!-->` and `<!--->`
//   at once (abrupt closing), otherwise at the first `-->` or `--!>`;
// - a Handlebars comment, which renders to nothing, with or without `~`.
const skippable =
  /[\t\n\f\r ]+|<!--(?:-?>|[\s\S]*?--!?>)|\{\{~?!--[\s\S]*?--~?\}\}|\{\{~?![\s\S]*?\}\}/y;

// `<!doctype` + ASCII whitespace + `html` + optional ASCII whitespace + `>`.
const doctype = /<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/iy;

/**
 * The pack's template must start with the HTML5 doctype, preceded only by
 * ASCII whitespace, HTML comments or Handlebars comments. One issue, at the
 * first character that is neither (an unclosed comment's start).
 */
export function doctypeIssues(text: string, file: string): PackIssue[] {
  let offset = 0;
  skippable.lastIndex = 0;
  while (skippable.test(text)) offset = skippable.lastIndex;
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
