// T14-11: Chromium prints repeating-linear-gradient() as a function-based
// shading that pdf.js samples once per stripe, so the self-check reads the
// stripes as solid black or blank. The upload refuses it wherever the print
// reads CSS (css-repeating-gradient, T06-12). T10-5 measured
// repeating-radial-gradient() misread the same way (pdf.js draws the rings
// as a scrambled pattern: 0.31 dark against PDFium's 0.50), so it is refused
// with every spelling the linear form is (T06-14).
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { type CheckResult, checkPack, type PackFiles } from './index.ts';

const code = 'css-repeating-gradient';
const templateFile = 'report.hbs';
const cssFile = 'report.css';
const extraFile = 'extra.css';
const paragraph = '<p data-gt="paragraph">{{value}}</p>';
const stripes =
  'repeating-linear-gradient(90deg, #000 0 2px, transparent 2px 4px)';
const rings = 'repeating-radial-gradient(circle, #000 0 2pt, #fff 2pt 4pt)';

function pack({
  css = '',
  template = paragraph,
  extra = '',
}: {
  css?: string;
  template?: string;
  extra?: string;
} = {}): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'repeating-gradient',
      name: 'Repeating gradient',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [cssFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [extraFile],
      },
    }),
    [templateFile]: withHead(template),
    [cssFile]: css,
    [extraFile]: extra,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
  };
}

/** Line and column (1-based) of `offset` in `text`. */
function position(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/** The issues of this code, in document order. */
const found = (result: CheckResult) =>
  result.issues
    .filter(issue => issue.code === code)
    .sort(
      (a, b) =>
        (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
    );

/**
 * The pack is refused with one css-repeating-gradient issue per token, each
 * pointing at the first character of the function name as written. Tokens
 * are given in document order; each is looked up after the previous one.
 */
function refused(files: PackFiles, file: string, tokens: string[]) {
  const result = checkPack(files);
  const text = String(files[file]);
  expect.soft(result.ok).toBe(false);
  expect.soft(result).not.toHaveProperty('pack');
  let from = 0;
  const expected = tokens.map(token => {
    const offset = text.indexOf(token, from);
    expect(offset, `${token} in ${text}`).toBeGreaterThanOrEqual(0);
    from = offset + token.length;
    return {
      code,
      file,
      ...position(text, offset),
      message: expect.stringMatching(/\S/),
    };
  });
  expect(found(result)).toEqual(expected);
  return result;
}

const accepted = (files: PackFiles) =>
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });

describe('css-repeating-gradient in a manifest stylesheet', () => {
  it('the test pack passes without a repeating linear gradient', () => {
    accepted(pack());
    accepted(pack({ css: 'p { color: black; }' }));
  });

  it.each([
    ['plain', `p { background: ${stripes}; }`, 'repeating-linear-gradient'],
    [
      'any letter case',
      'p { background: REPEATING-Linear-Gradient(red, blue); }',
      'REPEATING-Linear-Gradient',
    ],
    [
      'the -webkit- prefix',
      'p { background: -webkit-repeating-linear-gradient(red, blue); }',
      '-webkit-repeating-linear-gradient',
    ],
    [
      'inside @media, @supports and @layer',
      `@media print { @supports (display: grid) { @layer base { p { background: ${stripes}; } } } }`,
      'repeating-linear-gradient',
    ],
    [
      'a custom property used through var()',
      `:root { --stripes: ${stripes}; } p { background: var(--stripes); }`,
      'repeating-linear-gradient',
    ],
    [
      'inside image-set()',
      `p { background-image: image-set(${stripes} 1x); }`,
      'repeating-linear-gradient',
    ],
    [
      'a mask image',
      `p { mask-image: ${stripes}; }`,
      'repeating-linear-gradient',
    ],
    [
      'a border image',
      `p { border-image: ${stripes} 30; }`,
      'repeating-linear-gradient',
    ],
    [
      'after a comment and a string that mention it',
      `/* repeating-linear-gradient( */ p::before { content: "repeating-linear-gradient("; background: ${stripes}; }`,
      'repeating-linear-gradient(90deg',
    ],
  ])('refuses %s', (_form, css, token) => {
    refused(pack({ css }), cssFile, [token]);
  });

  it('reports every occurrence', () => {
    refused(
      pack({
        css: `p { background: ${stripes}; }\nh1 { background: -webkit-${stripes}; }`,
      }),
      cssFile,
      ['repeating-linear-gradient', '-webkit-repeating-linear-gradient'],
    );
  });

  it.each([
    [
      'a hex escape in the name',
      'p { background: repeating-linear-gradi\\65nt(red, blue); }',
    ],
    [
      'a hex escape ending in a space',
      'p { background: \\72 epeating-linear-gradient(red, blue); }',
    ],
    [
      'an escaped letter',
      'p { background: repeating-\\linear-gradient(red, blue); }',
    ],
  ])('refuses %s, beside css-escape', (_form, css) => {
    const name = css.slice(css.indexOf(': ') + 2, css.indexOf('('));
    const result = refused(pack({ css }), cssFile, [name]);
    expect(result.issues.map(issue => issue.code)).toContain('css-escape');
  });

  it('names the alternatives in the message', () => {
    const [issue] = found(
      checkPack(pack({ css: `p { background: ${stripes}; }` })),
    );
    expect(issue?.message).toMatch(/repeating-linear-gradient/);
    expect(issue?.message).toMatch(/<rect>/);
    expect(issue?.message).toMatch(/linear-gradient\(/);
    // T06-14: a tile sized in px prints a third dark instead of half (T10-5).
    expect(issue?.message).toMatch(/ 4pt 100%/);
    expect(issue?.message).not.toMatch(/\dpx/);
  });

  it.each([
    [
      'repeating-conic-gradient',
      'repeating-conic-gradient(#000 0 10deg, #fff 10deg 20deg)',
    ],
    ['conic-gradient', 'conic-gradient(#000, #fff)'],
    ['radial-gradient', 'radial-gradient(#000, #fff)'],
    ['-webkit-radial-gradient', '-webkit-radial-gradient(#000, #fff)'],
    [
      'a tiled fixed-size radial-gradient',
      'radial-gradient(circle, #000 50%, transparent 50%) 0 0 / 4pt 4pt',
    ],
    ['linear-gradient', 'linear-gradient(90deg, #000 50%, transparent 50%)'],
    [
      'a tiled fixed-size linear-gradient',
      'linear-gradient(90deg, #000 50%, transparent 50%) 0 0 / 4pt 100%',
    ],
    [
      'a tiled linear-gradient sized in px',
      'linear-gradient(90deg, #000 50%, transparent 50%) 0 0 / 4px 100%',
    ],
    ['-webkit-linear-gradient', '-webkit-linear-gradient(left, #000, #fff)'],
  ])('accepts %s', (_name, value) => {
    accepted(pack({ css: `p { background: ${value}; }` }));
  });

  it.each([
    ['a comment', '/* background: repeating-linear-gradient(red, blue); */'],
    [
      'a string',
      'p::before { content: "repeating-linear-gradient(red, blue)"; }',
    ],
    [
      'an identifier, not a function',
      'p { animation-name: repeating-linear-gradient; }',
    ],
    [
      'the name followed by a space, which CSS does not read as a function',
      'p { background: repeating-linear-gradient (red, blue); }',
    ],
  ])('accepts the name in %s', (_where, css) => {
    accepted(pack({ css }));
  });
});

describe('css-repeating-gradient in the template', () => {
  it('refuses it in a <style> element', () => {
    const template = `<head><style>\np { background: ${stripes}; }\n</style></head>\n${paragraph}`;
    refused(pack({ template }), templateFile, ['repeating-linear-gradient']);
  });

  it('refuses it in a style attribute', () => {
    const template = `<p data-gt="paragraph" style="background: ${stripes}">{{value}}</p>`;
    refused(pack({ template }), templateFile, ['repeating-linear-gradient']);
  });

  it('refuses it when an HTML character reference spells part of the name', () => {
    const template =
      '<p data-gt="paragraph" style="background: repeating&#45;linear-gradient(red, blue)">{{value}}</p>';
    refused(pack({ template }), templateFile, [
      'repeating&#45;linear-gradient',
    ]);
  });

  // An SVG <style> element is refused by the allowlist (html-unsupported).
  it('refuses it in an inline SVG style attribute and presentation attribute', () => {
    const template = `<svg data-gt="image" viewBox="0 0 10 10"><rect width="10" height="10" style="fill: ${stripes}"/><rect width="5" height="5" fill="${stripes}"/></svg>${paragraph}`;
    refused(pack({ template }), templateFile, [
      'repeating-linear-gradient',
      'repeating-linear-gradient',
    ]);
  });

  it('refuses it inside {{#if}} branches and <template>', () => {
    const template = `{{#if value}}<p data-gt="paragraph" style="background: ${stripes}">{{value}}</p>{{else}}<p data-gt="paragraph" style="background: -webkit-${stripes}">{{value}}</p>{{/if}}<template><p style="background: ${stripes}">x</p></template>`;
    refused(pack({ template }), templateFile, [
      'repeating-linear-gradient',
      '-webkit-repeating-linear-gradient',
      'repeating-linear-gradient',
    ]);
  });

  it('accepts the other gradients in a style attribute', () => {
    accepted(
      pack({
        template:
          '<p data-gt="paragraph" style="background: repeating-conic-gradient(#000 0 10deg, #fff 10deg 20deg), conic-gradient(#000, #fff), radial-gradient(#000, #fff), linear-gradient(90deg, #000 50%, transparent 50%) 0 0 / 4pt 100%">{{value}}</p>',
      }),
    );
  });
});

describe('css-repeating-gradient in stylesheets the pack loads', () => {
  it('refuses it in a stylesheet a <link> loads', () => {
    refused(
      pack({
        template: `<head><link rel="stylesheet" href="${extraFile}"></head>\n${paragraph}`,
        extra: `p { background: ${stripes}; }`,
      }),
      extraFile,
      ['repeating-linear-gradient'],
    );
  });

  it('refuses it in a stylesheet an @import loads', () => {
    refused(
      pack({
        css: `@import "${extraFile}";`,
        extra: `p { background: ${stripes}; }`,
      }),
      extraFile,
      ['repeating-linear-gradient'],
    );
  });
});

describe('css-repeating-gradient for repeating-radial-gradient (T06-14)', () => {
  it.each([
    ['plain', `p { background: ${rings}; }`, 'repeating-radial-gradient'],
    [
      'any letter case',
      'p { background: Repeating-RADIAL-gradient(red, blue); }',
      'Repeating-RADIAL-gradient',
    ],
    [
      'the -webkit- prefix',
      'p { background: -webkit-repeating-radial-gradient(red, blue); }',
      '-webkit-repeating-radial-gradient',
    ],
    [
      'the -moz- prefix',
      'p { background: -moz-repeating-radial-gradient(red, blue); }',
      '-moz-repeating-radial-gradient',
    ],
    [
      'inside @media, @supports and @layer',
      `@media print { @supports (display: grid) { @layer base { p { background: ${rings}; } } } }`,
      'repeating-radial-gradient',
    ],
    [
      'a custom property used through var()',
      `:root { --rings: ${rings}; } p { background: var(--rings); }`,
      'repeating-radial-gradient',
    ],
    [
      'inside image-set()',
      `p { background-image: image-set(${rings} 1x); }`,
      'repeating-radial-gradient',
    ],
    [
      'a mask image',
      `p { mask-image: ${rings}; }`,
      'repeating-radial-gradient',
    ],
    [
      'a border image',
      `p { border-image: ${rings} 30; }`,
      'repeating-radial-gradient',
    ],
    [
      'after a comment and a string that mention it',
      `/* repeating-radial-gradient( */ p::before { content: "repeating-radial-gradient("; background: ${rings}; }`,
      'repeating-radial-gradient(circle',
    ],
  ])('refuses %s', (_form, css, token) => {
    refused(pack({ css }), cssFile, [token]);
  });

  it('reports both repeating forms, each where it is written', () => {
    refused(
      pack({
        css: `p { background: ${rings}, ${stripes}; }\nh1 { background: -webkit-${rings}; }`,
      }),
      cssFile,
      [
        'repeating-radial-gradient',
        'repeating-linear-gradient',
        '-webkit-repeating-radial-gradient',
      ],
    );
  });

  it.each([
    [
      'a hex escape in the name',
      'p { background: repeating-radial-gradi\\65nt(red, blue); }',
    ],
    [
      'a hex escape ending in a space',
      'p { background: \\72 epeating-radial-gradient(red, blue); }',
    ],
    [
      'an escaped letter',
      'p { background: repeating-\\radial-gradient(red, blue); }',
    ],
  ])('refuses %s, beside css-escape', (_form, css) => {
    const name = css.slice(css.indexOf(': ') + 2, css.indexOf('('));
    const result = refused(pack({ css }), cssFile, [name]);
    expect(result.issues.map(issue => issue.code)).toContain('css-escape');
  });

  it('names the function, the alternatives and a pt tile in the message', () => {
    const [issue] = found(
      checkPack(pack({ css: `p { background: ${rings}; }` })),
    );
    expect(issue?.message).toMatch(/repeating-radial-gradient/);
    expect(issue?.message).toMatch(/<rect>/);
    expect(issue?.message).toMatch(/linear-gradient\(/);
    expect(issue?.message).toMatch(/ 4pt 100%/);
    expect(issue?.message).not.toMatch(/\dpx/);
  });

  it.each([
    ['a comment', '/* background: repeating-radial-gradient(red, blue); */'],
    [
      'a string',
      'p::before { content: "repeating-radial-gradient(red, blue)"; }',
    ],
    [
      'an identifier, not a function',
      'p { animation-name: repeating-radial-gradient; }',
    ],
    [
      'the name followed by a space, which CSS does not read as a function',
      'p { background: repeating-radial-gradient (red, blue); }',
    ],
    [
      'a longer name that ends like it',
      'p { background: not-repeating-radial-gradient(red, blue); }',
    ],
  ])('accepts the name in %s', (_where, css) => {
    accepted(pack({ css }));
  });

  it('refuses it in a <style> element', () => {
    const template = `<head><style>\np { background: ${rings}; }\n</style></head>\n${paragraph}`;
    refused(pack({ template }), templateFile, ['repeating-radial-gradient']);
  });

  it('refuses it in a style attribute', () => {
    const template = `<p data-gt="paragraph" style="background: ${rings}">{{value}}</p>`;
    refused(pack({ template }), templateFile, ['repeating-radial-gradient']);
  });

  it('refuses it when an HTML character reference spells part of the name', () => {
    const template =
      '<p data-gt="paragraph" style="background: repeating&#45;radial&#x2d;gradient(red, blue)">{{value}}</p>';
    refused(pack({ template }), templateFile, [
      'repeating&#45;radial&#x2d;gradient',
    ]);
  });

  it('refuses it in an inline SVG style attribute and presentation attribute', () => {
    const template = `<svg data-gt="image" viewBox="0 0 10 10"><rect width="10" height="10" style="fill: ${rings}"/><rect width="5" height="5" fill="${rings}"/></svg>${paragraph}`;
    refused(pack({ template }), templateFile, [
      'repeating-radial-gradient',
      'repeating-radial-gradient',
    ]);
  });

  it('refuses it inside {{#if}} branches and <template>', () => {
    const template = `{{#if value}}<p data-gt="paragraph" style="background: ${rings}">{{value}}</p>{{else}}<p data-gt="paragraph" style="background: -webkit-${rings}">{{value}}</p>{{/if}}<template><p style="background: ${rings}">x</p></template>`;
    refused(pack({ template }), templateFile, [
      'repeating-radial-gradient',
      '-webkit-repeating-radial-gradient',
      'repeating-radial-gradient',
    ]);
  });

  it('refuses it in a stylesheet a <link> loads', () => {
    refused(
      pack({
        template: `<head><link rel="stylesheet" href="${extraFile}"></head>\n${paragraph}`,
        extra: `p { background: ${rings}; }`,
      }),
      extraFile,
      ['repeating-radial-gradient'],
    );
  });

  it('refuses it in a stylesheet an @import loads', () => {
    refused(
      pack({
        css: `@import "${extraFile}";`,
        extra: `p { background: ${rings}; }`,
      }),
      extraFile,
      ['repeating-radial-gradient'],
    );
  });
});
