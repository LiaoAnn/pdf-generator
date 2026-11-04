// T14-11, T06-12: Chromium prints an SVG gradient with spreadMethod="repeat"
// or "reflect" as the same function-based shading as
// repeating-linear-gradient(), which pdf.js samples once per stripe or ring:
// linearGradient by T14-11's measurements, radialGradient by T06-12's
// (pdf.js draws a scrambled pattern where PDFium draws rings). The upload
// refuses both values on both (css-repeating-gradient).
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

const code = 'css-repeating-gradient';
const templateFile = 'report.hbs';
const paragraph = '<p data-gt="paragraph">{{value}}</p>';

/** An SVG filled by `gradient`, the start tag of a linear or radial gradient. */
const svg = (gradient: string) => {
  const end = /^<radial/i.test(gradient) ? 'radialGradient' : 'linearGradient';
  return `<svg data-gt="image" viewBox="0 0 10 10"><defs>${gradient}<stop offset="0" stop-color="black"/><stop offset="0.5" stop-color="white"/></${end}></defs><rect width="10" height="10" fill="url(#g)"/></svg>`;
};

function pack(template: string): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'spread-method',
      name: 'Spread method',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [],
      },
    }),
    [templateFile]: withHead(`${template}${paragraph}`),
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

/**
 * Refused with one css-repeating-gradient issue per token (document order),
 * each pointing at the start of the attribute as written.
 */
function refused(files: PackFiles, tokens: string[]) {
  const result = checkPack(files);
  const text = String(files[templateFile]);
  expect.soft(result.ok).toBe(false);
  expect.soft(result).not.toHaveProperty('pack');
  let from = 0;
  const expected = tokens.map(token => {
    const offset = text.indexOf(token, from);
    expect(offset, `${token} in ${text}`).toBeGreaterThanOrEqual(0);
    from = offset + token.length;
    return {
      code,
      file: templateFile,
      ...position(text, offset),
      message: expect.stringMatching(/\S/),
    };
  });
  expect(
    result.issues
      .filter(issue => issue.code === code)
      .sort(
        (a, b) =>
          (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
      ),
  ).toEqual(expected);
  return result;
}

const accepted = (files: PackFiles) =>
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });

describe('css-repeating-gradient for SVG spreadMethod', () => {
  it.each([
    ['repeat', '<linearGradient id="g" spreadMethod="repeat" x2="0.1">'],
    ['reflect', '<linearGradient id="g" x2="0.1" spreadMethod="reflect">'],
    [
      'an attribute name in another case (HTML parsing restores spreadMethod)',
      '<linearGradient id="g" SPREADMETHOD="repeat" x2="0.1">',
    ],
    [
      'an element name in another case',
      '<LINEARGRADIENT id="g" spreadmethod="reflect" x2="0.1">',
    ],
    [
      'a value in another case or with spaces',
      '<linearGradient id="g" spreadMethod=" Repeat " x2="0.1">',
    ],
    [
      'a character reference in the value',
      '<linearGradient id="g" spreadMethod="&#114;epeat" x2="0.1">',
    ],
    [
      'an unquoted value',
      '<linearGradient id="g" spreadMethod=reflect x2="0.1">',
    ],
    [
      'a radialGradient with repeat',
      '<radialGradient id="g" spreadMethod="repeat" r="0.1">',
    ],
    [
      'a radialGradient with reflect',
      '<radialGradient id="g" r="0.1" spreadMethod="reflect">',
    ],
    [
      'a radialGradient in another case',
      '<RADIALGRADIENT id="g" SpreadMethod="Reflect" r="0.1">',
    ],
  ])('refuses %s', (_form, gradient) => {
    const at = gradient.search(/spreadmethod/i);
    refused(pack(svg(gradient)), [
      gradient.slice(at, at + 'spreadMethod'.length),
    ]);
  });

  it('refuses it inside {{#if}} branches and <template>', () => {
    const template = `{{#if value}}${svg('<linearGradient id="g" spreadMethod="repeat">')}{{else}}${svg('<linearGradient id="g" spreadMethod="reflect">')}{{/if}}<template>${svg('<linearGradient id="g" spreadMethod="repeat">')}</template>`;
    refused(pack(template), ['spreadMethod', 'spreadMethod', 'spreadMethod']);
  });

  it('names the alternatives in the message', () => {
    const issue = checkPack(
      pack(svg('<linearGradient id="g" spreadMethod="repeat">')),
    ).issues.find(found => found.code === code);
    expect(issue?.message).toMatch(/spreadMethod/);
    expect(issue?.message).toMatch(/<rect>/);
    expect(issue?.message).toMatch(/linear-gradient\(/);
  });

  it.each([
    ['no spreadMethod', '<linearGradient id="g" x2="0.1">'],
    [
      'spreadMethod="pad"',
      '<linearGradient id="g" spreadMethod="pad" x2="0.1">',
    ],
    [
      'a radialGradient with spreadMethod="pad"',
      '<radialGradient id="g" spreadMethod="pad" r="0.1">',
    ],
  ])('accepts %s', (_form, gradient) => {
    accepted(pack(svg(gradient)));
  });

  it('accepts spreadMethod in text or in an HTML attribute', () => {
    accepted(
      pack(
        '<p data-gt="paragraph" title="spreadMethod=repeat">spreadMethod="repeat"</p>',
      ),
    );
  });
});
