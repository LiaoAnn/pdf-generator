import { describe, expect, it } from 'vitest';
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
    [templateFile]: template,
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
