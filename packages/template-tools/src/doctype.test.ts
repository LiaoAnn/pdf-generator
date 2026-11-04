// T06-10: without `<!doctype html>` Chrome lays the template out in quirks
// mode (tables fall back to 16px text, pages split differently, some fixtures
// fail text_missing), unlike the browser preview its author designed in. The
// print path keeps the template's own doctype (prepareHtml), so the upload
// requires the HTML5 doctype first, after only ASCII whitespace and comments
// (template-doctype).
import { describe, expect, it } from 'vitest';
import { type CheckResult, checkPack, type PackFiles } from './index.ts';

const code = 'template-doctype';
const templateFile = 'templates/report.hbs';
const document =
  '<html lang="zh-Hant-TW"><head><meta charset="utf-8"></head><body><p data-gt="paragraph">{{value}}</p></body></html>\n';

function pack(template: string): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'doctype',
      name: 'Doctype',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: ['styles/report.css'],
        rules: 'data/rules.json',
        sample: 'data/sample.json',
      },
    }),
    [templateFile]: template,
    'styles/report.css': 'p { margin: 0; }\n',
    'data/rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'data/sample.json': JSON.stringify({ value: 'hello' }),
  };
}

const doctypeIssues = (result: CheckResult) =>
  result.issues.filter(issue => issue.code === code);

describe('checkPack: the template starts with <!doctype html>', () => {
  it.each([
    ['lower case', '<!doctype html>\n'],
    ['upper case', '<!DOCTYPE html>\n'],
    ['mixed case', '<!DocType HTML>'],
    ['whitespace inside', '<!doctype \t html >\n'],
    ['ASCII whitespace before', '\n\t \r\n\f<!doctype html>\n'],
    [
      'HTML comments before',
      '<!-- 樣板 v2 -->\n<!-- -- note -- -->\n<!doctype html>\n',
    ],
    [
      'a Handlebars comment before',
      '{{! renders nothing }}\n<!doctype html>\n',
    ],
    ['a long Handlebars comment before', '{{!-- {{x}} --}}<!doctype html>'],
    // Whitespace control strips only whitespace: still nothing before it.
    [
      'Handlebars comments with whitespace control before',
      '{{~! note ~}}\n{{~!-- note --~}}\n<!doctype html>\n',
    ],
    // `--!>` ends a comment too (a parse error, but the comment ends there).
    ['a comment ended by --!>', '<!-- note --!>\n<!doctype html>\n'],
  ])('accepts %s', (_, prefix) => {
    const result = checkPack(pack(`${prefix}${document}`));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['no doctype', '', 1, 1],
    ['the doctype after the head', '<head></head><!doctype html>', 1, 1],
    ['text before it', 'x<!doctype html>', 1, 1],
    // U+00A0 is whitespace to JavaScript's \s but a character to the HTML
    // parser: it starts the document in quirks mode before the doctype.
    ['a no-break space before it', ' <!doctype html>', 1, 1],
    ['a zero-width space before it', '​<!doctype html>', 1, 1],
    [
      'an HTML 4.01 doctype',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
      1,
      1,
    ],
    ['a doctype naming another root', '<!doctype svg>', 1, 1],
    ['a doctype only in a branch', '{{#if value}}<!doctype html>{{/if}}', 1, 1],
    ['a doctype written by a statement', '{{{value}}}', 1, 1],
    ['an unclosed comment around it', '<!-- note <!doctype html>', 1, 1],
    ['content after comments and blank lines', '\n\n<!-- c -->\n', 4, 1],
    ['content after a doctype-like comment', '<!-- <!doctype html> -->', 1, 25],
    // The HTML tokenizer ends `<!-->` and `<!--->` at once (abrupt closing),
    // so what follows is content, not the rest of a comment.
    [
      'a doctype after an abruptly closed comment',
      '<!--><!doctype svg><!-- --><!doctype html>',
      1,
      6,
    ],
    [
      'a doctype after a three-dash abruptly closed comment',
      '<!---><!doctype svg><!-- --><!doctype html>',
      1,
      7,
    ],
    // Not a doctype name separator or terminator to the HTML tokenizer.
    ['a no-break space inside it', '<!doctype html>', 1, 1],
    ['a no-break space before its >', '<!doctype html >', 1, 1],
  ])(
    'refuses %s, at the first character that is not whitespace or a comment',
    (_, prefix, line, column) => {
      const result = checkPack(pack(`${prefix}${document}`));
      expect(result.ok).toBe(false);
      expect(doctypeIssues(result)).toEqual([
        {
          code,
          file: templateFile,
          line,
          column,
          message: expect.stringContaining('<!doctype html>'),
        },
      ]);
    },
  );

  it('reports it once, alongside the template’s other issues', () => {
    const result = checkPack(
      pack(
        '<html><head></head><body><p>unmarked</p><p data-gt="paragraph">{{value}}</p></body></html>',
      ),
    );
    expect(result.ok).toBe(false);
    expect(doctypeIssues(result)).toHaveLength(1);
    expect(result.issues.map(issue => issue.code)).toContain('gt-unmarked');
  });
});
