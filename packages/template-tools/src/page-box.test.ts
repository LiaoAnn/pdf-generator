import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

const templateFile = 'report.hbs';
const cssFile = 'report.css';
const paragraph = '<p data-gt="paragraph">{{value}}</p>';

function pack(css = '', template = paragraph): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'page-box',
      name: 'Page box',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [cssFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [],
      },
    }),
    [templateFile]: withHead(template),
    [cssFile]: css,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
  };
}

function rejects(files: PackFiles, token: string, file = cssFile) {
  const result = checkPack(files);
  const source = String(files[file]);
  const offset = source.indexOf(token);
  expect(offset).toBeGreaterThanOrEqual(0);
  const lines = source.slice(0, offset).split('\n');
  expect.soft(result.ok).toBe(false);
  expect.soft(result).not.toHaveProperty('pack');
  expect(result.issues).toEqual([
    expect.objectContaining({
      code: 'css-page-box',
      file,
      line: lines.length,
      column: (lines.at(-1)?.length ?? 0) + 1,
      message: expect.stringMatching(/\S/),
    }),
  ]);
}

describe('page-box upload guard', () => {
  it.each([
    ['body { font-family: "Arial"; padding-left: 10mm; }', 'padding-left'],
    ['body { content: "a;b}"; padding: 1mm; }', 'padding'],
  ])(
    'a closed CSS string cannot hide later page movement: %s',
    (css, token) => {
      rejects(pack(css), token);
      rejects(
        pack('', `<style>${css}</style>${paragraph}`),
        token,
        templateFile,
      );
    },
  );

  it('quoted font names and a fallback keep a neutral html margin allowed', () => {
    const css = 'html { font-family: "Noto Sans TC", sans-serif; margin: 0 }';
    expect(checkPack(pack(css))).toMatchObject({ ok: true, issues: [] });
    expect(
      checkPack(pack('', `<style>${css}</style>${paragraph}`)),
    ).toMatchObject({ ok: true, issues: [] });
  });

  it.each([
    '.pagedjs_page',
    '.PAGEDJS_pages > div',
    '[class*=pagedjs]',
    '#pagedjs_x',
  ])(
    'rejects reserved selector %s even without a box-model declaration',
    selector => rejects(pack(`\n  ${selector} { color: red }`), selector),
  );

  describe.each(['manifest stylesheet', 'template <style>'])(
    'quoted Paged.js selectors in %s',
    source => {
      function rejectsCss(css: string, token: string) {
        if (source === 'manifest stylesheet') rejects(pack(css), token);
        else
          rejects(
            pack('', `<style>\n${css}\n</style>${paragraph}`),
            token,
            templateFile,
          );
      }

      it.each(
        ['=', '~=', '|=', '^=', '$=', '*='].flatMap(operator =>
          [
            'pagedjs',
            'PAGEDJS',
            "'pagedjs'",
            "'PAGEDJS'",
            '"pagedjs"',
            '"PAGEDJS"',
          ].flatMap(value =>
            ['', ' i', ' s'].map(flag => `[class${operator}${value}${flag}]`),
          ),
        ),
      )(
        'rejects attribute value %s regardless of quoting, operator, case or flag at the selector start',
        selector =>
          rejectsCss(
            `p { color: black }\n  ${selector} { margin: 20mm }`,
            selector,
          ),
      );

      describe.each([
        '',
        '@media print',
        '@supports (display: grid)',
        '@layer print',
      ])('selector context %s', wrapper => {
        it.each([
          ['p, [class^="pagedjs"]', '[class^="pagedjs"]'],
          ["p, [class^='pagedjs']", "[class^='pagedjs']"],
          ['p:not([class*="pagedjs"])', 'p:not('],
          ["p:not([class*='pagedjs'])", 'p:not('],
          ['p:is(.report, [class*="pagedjs"])', 'p:is('],
          ["p:is(.report, [class*='pagedjs'])", 'p:is('],
        ])(
          'rejects quoted Paged.js in %s at the offending selector rather than the value',
          (selector, token) => {
            const rule = `\n  ${selector} { color: red }\n`;
            rejectsCss(wrapper ? `${wrapper} {${rule}}` : rule, token);
          },
        );
      });

      it.each([
        '[title="}"]',
        "[title='}']",
        '[title="a;b{c}"]',
        "[title='a;b{c}']",
      ])(
        'keeps parsing after quoted selector punctuation in %s and rejects only the later body padding',
        selector =>
          rejectsCss(
            `\n  ${selector} { color: red }\n  body { padding: 1mm }`,
            'padding',
          ),
      );
    },
  );

  describe.each(['manifest stylesheet', 'template <style>'])(
    'escaped Paged.js selectors in %s',
    source => {
      function checkEscapedCss(css: string, selector?: string) {
        const inline = source === 'template <style>';
        const files = inline
          ? pack('', `<style>\n${css}\n</style>${paragraph}`)
          : pack(css);
        const file = inline ? templateFile : cssFile;
        const text = String(files[file]);
        const result = checkPack(files);
        function issueAt(code: string, offset: number) {
          const lines = text.slice(0, offset).split('\n');
          return expect.objectContaining({
            code,
            file,
            line: lines.length,
            column: (lines.at(-1)?.length ?? 0) + 1,
            message: expect.stringMatching(/\S/),
          });
        }

        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty('pack');
        const escapes = [...text.matchAll(/\\/g)].map(match =>
          issueAt('css-escape', match.index),
        );
        expect(
          result.issues.filter(issue => issue.code === 'css-escape'),
        ).toEqual(escapes);
        expect(
          result.issues.filter(issue => issue.code === 'css-page-box'),
        ).toEqual(
          selector ? [issueAt('css-page-box', text.indexOf(selector))] : [],
        );
        expect(result.issues).toHaveLength(escapes.length + (selector ? 1 : 0));
      }

      it.each([
        String.raw`.\70 agedjs_page`,
        String.raw`#\70 agedjs_page`,
        String.raw`.\000070agedjs_page`,
        String.raw`#\000070 agedjs_page`,
        '.\\70\tagedjs_page',
        '.\\70\nagedjs_page',
        String.raw`.\50 AGEDJS_page`,
        String.raw`.\pagedjs_page`,
        String.raw`#pa\gedjs_page`,
        String.raw`.pa\g\65 djs_page`,
      ])(
        'refuses escaped class/id %s at the selector start while retaining an issue at every backslash',
        selector =>
          checkEscapedCss(
            `p { color: black }\n  ${selector} { margin: 20mm }`,
            selector,
          ),
      );

      it.each(
        [
          String.raw`\70 agedjs`,
          String.raw`\000070agedjs`,
          String.raw`\000070 agedjs`,
          String.raw`pa\gedjs`,
        ].flatMap(value =>
          [value, `'${value}'`, `"${value}"`].flatMap(quoted =>
            ['', ' i'].map(flag => `[class*=${quoted}${flag}]`),
          ),
        ),
      )(
        'refuses escaped attribute value %s regardless of quoting or i flag at the selector start',
        selector =>
          checkEscapedCss(
            `p { color: black }\n  ${selector} { margin: 20mm }`,
            selector,
          ),
      );

      it('does not mistake an escaped report class for pagedjs; reports only css-escape', () => {
        checkEscapedCss(String.raw`.\72 eport { margin: 2mm }`);
      });

      it('consumes hex digits in an escape instead of treating them as simple escapes; reports only css-escape', () => {
        // \ed is U+00ED, followed by js; it does not spell pagedjs.
        checkEscapedCss(String.raw`.pa\g\edjs_page { margin: 2mm }`);
      });

      it('does not treat escaped pagedjs in declaration content as a selector; reports only css-escape', () => {
        checkEscapedCss(String.raw`p::before { content: "\70 agedjs" }`);
      });
    },
  );

  describe.each(['@media print', '@supports (display: grid)', '@layer print'])(
    'inside %s',
    wrapper => {
      it.each([
        ['.pagedjs_page { color: red }', '.pagedjs_page'],
        ['body { padding-left: 10mm }', 'padding-left'],
      ])('rejects nested page-box changes: %s', (rule, token) => {
        rejects(pack(`${wrapper} {\n  ${rule}\n}`), token);
      });
    },
  );

  it.each([
    'html',
    'body',
    ':root',
    '*',
    'html, body',
    'p, body.x',
    'html > body',
    'BODY.report',
  ])('rejects movement when the selector subject is %s', selector =>
    rejects(
      pack(`${selector} {\n  margin-inline-start: 2mm;\n}`),
      'margin-inline-start',
    ),
  );

  it.each([
    'margin: 0 1mm',
    'margin-top: -2mm',
    'padding: 1px',
    'padding-block-end: 1mm',
    'border: 1px solid',
    'border-top: thin solid',
    'border-top-width: 1px',
    'border-block: 1px solid',
    'border-inline-start-width: thin',
    'position: relative',
    'transform: translateY(1mm)',
    'translate: 1mm',
    'rotate: 1deg',
    'scale: 2',
    'zoom: 1.1',
    'margin: auto',
    'padding-left: var(--inset)',
  ])('rejects a nonneutral root declaration %s', declaration =>
    rejects(pack(`body {\n  ${declaration};\n}`), declaration),
  );

  it('checks every manifest stylesheet rather than only the first', () => {
    const files = pack();
    const manifest = JSON.parse(String(files['manifest.json']));
    manifest.files.styles.push('second.css');
    files['manifest.json'] = JSON.stringify(manifest);
    files['second.css'] = '\n  body { padding-left: 10mm }';
    rejects(files, 'padding-left', 'second.css');
  });

  it.each(['.pagedjs_page { color: red }', 'body { padding-left: 10mm }'])(
    'locates forbidden inline stylesheet CSS in the original template: %s',
    css => {
      const token = css.startsWith('.') ? '.pagedjs_page' : 'padding-left';
      rejects(
        pack(
          '',
          `<html>\n<head><style>p { color: black }</style>\n<style>\n  ${css}\n</style></head><body>${paragraph}</body></html>`,
        ),
        token,
        templateFile,
      );
    },
  );

  it.each([
    '@page { margin: 20mm; @top-center { content: "Report"; padding: 2mm } }',
    'html, body { margin: 0; padding: 0 }',
    'body { margin: 0 }',
    '* { box-sizing: border-box; margin: 0 }',
    'html { font-size: 10pt; line-height: 1.5; color: #000 } body { font-family: sans-serif }',
    'body { margin: 0mm 0px 0 0mm !important; padding-inline: 0px 0; border-top-width: 0px; border-inline-width: 0 0mm }',
    'body { border: none; border-top: 0 !important; border-block: none; position: static; transform: none; translate: none; rotate: none; scale: none; zoom: normal }',
    ':root { zoom: 1 !important }',
    'p { margin: 4mm } .body { padding: 3mm } .html-note { margin: 1mm } tbody { border: 1px solid } div.body { padding: 2mm }',
    'body p { margin: 4mm } html > div { padding: 3mm }',
    '/* .pagedjs_page { margin-top: -20mm } */ p::before { content: "pagedjs" }',
    '[title="a{b"] { color: red } p { margin: 1mm }',
    "[title='a{b'] { color: red } p { margin: 1mm }",
    'p { font-family: "pagedjs" }',
    "p { font-family: 'pagedjs' }",
    '[class*="report"] { margin: 2mm }',
    "[class*='report'] { margin: 2mm }",
  ])('allows legitimate pack CSS without broadening the guard: %s', css => {
    expect(checkPack(pack(css))).toMatchObject({ ok: true, issues: [] });
    expect(
      checkPack(pack('', `<style>${css}</style>${paragraph}`)),
    ).toMatchObject({ ok: true, issues: [] });
  });

  it('allows style attributes because the guard scans rule-bearing CSS only', () => {
    expect(
      checkPack(
        pack(
          '',
          '<p data-gt="paragraph" style="padding-left: 10mm; transform: translateX(2mm)">hello</p>',
        ),
      ),
    ).toMatchObject({ ok: true, issues: [] });
  });
});
