// T06-16: inside an SVG image — an .svg file of the pack, or a
// data:image/svg+xml image anywhere — Chrome loads no other file or URL: a
// nested <image href="black.png">, <feImage>, <use href="x.svg#id">, XHTML
// <img>, @import, <?xml-stylesheet?>, XHTML <link>, CSS url(x.png) and an
// @font-face src all print nothing (T06-16 probes: ink, and the print
// Worker's request log shows no fetch), while the same references in the
// template itself, inline SVG included, load. So the upload refuses each one
// as asset-svg-nested, at the URL, even when the file is in the pack; data:
// URLs and same-document #fragments still work and stay accepted.
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

const code = 'asset-svg-nested';
const svgFile = 'assets/figure.svg';
const pngFile = 'assets/black.png';
const templateFile = 'report.hbs';
const styleFile = 'styles/main.css';
const ns = 'xmlns="http://www.w3.org/2000/svg"';
const xhtml = 'xmlns="http://www.w3.org/1999/xhtml"';

const svg = (inner: string, prolog = '') =>
  `${prolog}<svg ${ns} viewBox="0 0 40 10">${inner}</svg>`;
/** XHTML content inside an SVG image. */
const fo = (inner: string) =>
  svg(`<foreignObject width="40" height="10">${inner}</foreignObject>`);
const black = svg('<rect width="40" height="10" fill="#000"/>');
/** A 1x1 PNG's signature and IHDR are enough for an asset. */
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
]);

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const percent = (text: string) => encodeURIComponent(text);

function pack({
  file = svg(''),
  body = `<img data-gt="image" src="${svgFile}" alt="" width="40" height="10">`,
  css = '',
}: {
  file?: string;
  body?: string;
  css?: string;
}): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'svg-nested-refs',
      name: 'SVG nested references',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [styleFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [svgFile, pngFile],
      },
    }),
    [templateFile]: withHead(
      `${body}<img data-gt="image" src="${pngFile}" alt="" width="4" height="1"><p data-gt="paragraph">{{value}}</p>`,
    ),
    [styleFile]: css,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
    [svgFile]: file,
    [pngFile]: png,
  };
}

function position(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Refused with exactly one asset-svg-nested issue per token, in `file`, in
 * document order, each at the token's first occurrence after the previous
 * one, and nothing else refused.
 */
function refusedAt(
  files: PackFiles,
  tokens: string[],
  { file = svgFile, message = /\S/ }: { file?: string; message?: RegExp } = {},
) {
  const result = checkPack(files);
  expect.soft(result.ok).toBe(false);
  const text = String(files[file]);
  let from = 0;
  const expected = tokens.map(token => {
    const offset = text.indexOf(token, from);
    expect(offset, `${token} in ${text}`).toBeGreaterThanOrEqual(0);
    from = offset + token.length;
    return {
      code,
      file,
      ...position(text, offset),
      message: expect.stringMatching(message),
    };
  });
  expect(result.issues).toEqual(expected);
}

const accepted = (files: PackFiles) =>
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });

describe('nested images in SVG files', () => {
  it.each([
    [
      '<image href> of a pack PNG',
      svg('<image href="black.png" width="40" height="10"/>'),
      ['black.png'],
    ],
    [
      '<image href> of a pack SVG',
      svg('<image href="figure.svg" width="40" height="10"/>'),
      ['figure.svg'],
    ],
    [
      '<image xlink:href>',
      svg(
        '<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="black.png" width="40" height="10"/>',
      ),
      ['black.png'],
    ],
    [
      '<feImage href>',
      svg(
        '<defs><filter id="f"><feImage href="black.png"/></filter></defs><rect width="40" height="10" filter="url(#f)"/>',
      ),
      ['black.png'],
    ],
    [
      '<use href> of another file',
      svg('<use href="sym.svg#r"/>'),
      ['sym.svg#r'],
    ],
    [
      'an XHTML <img src>',
      fo(`<img ${xhtml} src="black.png"/>`),
      ['black.png'],
    ],
    [
      'each XHTML srcset candidate',
      fo(`<img ${xhtml} srcset="black.png 1x, figure.svg 2x"/>`),
      ['black.png', 'figure.svg'],
    ],
    [
      'an absolute URL',
      svg('<image href="https://example.com/a.png" width="40" height="10"/>'),
      ['https:'],
    ],
    [
      'a path leaving the folder',
      svg('<image href="../assets/black.png" width="40" height="10"/>'),
      ['../assets'],
    ],
    [
      'a character reference starting the URL',
      svg('<image href="&#98;lack.png" width="40" height="10"/>'),
      ['&#98;'],
    ],
    [
      'spaces around the URL (at its first character)',
      svg('<image href="  black.png " width="40" height="10"/>'),
      ['black.png'],
    ],
  ])('refuses %s, at the URL', (_, file, tokens) => {
    refusedAt(pack({ file }), tokens);
  });
});

describe('nested stylesheets and CSS url() in SVG files', () => {
  it.each([
    [
      '@import url() in <style>',
      svg('<style>@import url(black.css);</style>'),
      ['black.css'],
    ],
    [
      '@import of a string in <style>',
      svg('<style>@import "black.css";</style>'),
      ['black.css'],
    ],
    [
      '@import in CDATA',
      svg('<style><![CDATA[@import url("black.css");]]></style>'),
      ['black.css'],
    ],
    [
      'an xml-stylesheet processing instruction',
      `<?xml-stylesheet type="text/css" href="black.css"?>\n${svg('')}`,
      ['black.css'],
    ],
    [
      'an XHTML <link rel="stylesheet">',
      fo(`<link ${xhtml} rel="stylesheet" href="black.css"/>`),
      ['black.css'],
    ],
    [
      'a background url() in foreignObject HTML',
      fo(
        `<div ${xhtml} style="width:40px;height:10px;background:url(black.png)"></div>`,
      ),
      ['black.png'],
    ],
    [
      'a url() in <style>',
      svg('<style>rect { fill: url(sym.svg#r); }</style>'),
      ['sym.svg#r'],
    ],
    [
      'an @font-face src url() (probe 2: never fetched)',
      svg(
        "<style>@font-face { font-family: F; src: url(font.woff2) format('woff2'); } text { font-family: F; }</style><text>Ab</text>",
      ),
      ['font.woff2'],
    ],
    [
      'a presentation attribute url()',
      svg('<rect width="40" height="10" fill="url(paint.svg#g)"/>'),
      ['paint.svg#g'],
    ],
    [
      'an image-set() string',
      fo(
        `<div ${xhtml} style='background-image:image-set("black.png" 1x)'></div>`,
      ),
      ['black.png'],
    ],
  ])('refuses %s, at the URL', (_, file, tokens) => {
    refusedAt(pack({ file }), tokens);
  });
});

describe('what an SVG image still loads or never loads', () => {
  it.each([
    [
      'a same-document <use href="#r">',
      svg('<defs><rect id="r" width="40" height="10"/></defs><use href="#r"/>'),
    ],
    [
      'a same-document fill="url(#g)"',
      svg(
        '<defs><linearGradient id="g"/></defs><rect width="40" height="10" fill="url(#g)"/>',
      ),
    ],
    [
      'a same-document url(#g) in <style>',
      svg(
        '<style>rect { fill: url( "#g" ); }</style><rect width="40" height="10"/>',
      ),
    ],
    [
      'a data:image/svg+xml image',
      svg(
        `<image href="data:image/svg+xml;base64,${base64(black)}" width="40" height="10"/>`,
      ),
    ],
    [
      'a data:image/png image',
      svg(
        '<image href="data:image/png;base64,iVBORw0KGgo=" width="40" height="10"/>',
      ),
    ],
    [
      'a hyperlink',
      svg('<a href="https://example.com/"><rect width="40" height="10"/></a>'),
    ],
    ['an XHTML hyperlink', fo(`<a ${xhtml} href="page.html">x</a>`)],
    [
      'a script (it does not run)',
      svg('<script href="x.js"/><script src="y.js"/>'),
    ],
    ['an empty href', svg('<image href="" width="40" height="10"/>')],
  ])('accepts %s', (_, file) => {
    accepted(pack({ file }));
  });

  it('still refuses a data: stylesheet as asset-data, not asset-svg-nested', () => {
    const file = svg(
      `<style>@import url("data:text/css,${percent('rect{fill:#000}')}");</style>`,
    );
    const result = checkPack(pack({ file }));
    expect(result.issues.map(issue => issue.code)).toEqual(['asset-data']);
  });
});

describe('nested references inside data:image/svg+xml images', () => {
  const nested = svg('<image href="assets/black.png" width="40" height="10"/>');
  const nestedUrl = `data:image/svg+xml,${percent(nested)}`;
  const importUrl = `data:image/svg+xml;base64,${base64(svg('<style>@import url(styles/main.css);</style>'))}`;

  it('refuses one in the template <img src>, at the data: URL', () => {
    refusedAt(
      pack({ body: `<img data-gt="image" src="${nestedUrl}" alt="">` }),
      ['data:'],
      { file: templateFile, message: /data:image\/svg\+xml/i },
    );
  });

  it('refuses an @import in a template inline SVG <image href> data: URL', () => {
    refusedAt(
      pack({
        body: `<svg data-gt="image" viewBox="0 0 40 10"><image href="${importUrl}" width="40" height="10"/></svg>`,
      }),
      ['data:'],
      { file: templateFile, message: /data:image\/svg\+xml/i },
    );
  });

  it('refuses one in a stylesheet url(), at the data: URL', () => {
    const css = `div { background: url("${nestedUrl}"); }`;
    refusedAt(pack({ css }), ['data:'], {
      file: styleFile,
      message: /data:image\/svg\+xml/i,
    });
  });

  it('refuses one in a data: image nested in an SVG file, at the outer URL', () => {
    const file = svg(
      `<image href="data:image/svg+xml;base64,${base64(svg(`<image href="${nestedUrl}" width="40" height="10"/>`))}" width="40" height="10"/>`,
    );
    refusedAt(pack({ file }), ['data:'], { message: /data:image\/svg\+xml/i });
  });
});

describe('inline SVG in the template loads its references', () => {
  it.each([
    [
      '<image href> of a pack PNG',
      `<svg data-gt="image" viewBox="0 0 40 10"><image href="${pngFile}" width="40" height="10"/></svg>`,
    ],
    [
      '<image href> of a pack SVG',
      `<svg data-gt="image" viewBox="0 0 40 10"><image href="${svgFile}" width="40" height="10"/></svg>`,
    ],
    [
      '<image xlink:href>',
      `<svg data-gt="image" viewBox="0 0 40 10"><image xlink:href="${pngFile}" width="40" height="10"/></svg>`,
    ],
  ])('accepts %s', (_, body) => {
    accepted(pack({ body }));
  });
});
