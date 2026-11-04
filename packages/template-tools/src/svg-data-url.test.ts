// T06-13: Chrome renders a data:image/svg+xml image inside an SVG image
// (the probe's nested case misread like the file itself), and applies a
// data: stylesheet there (<?xml-stylesheet?>, @import, XHTML <link>), while
// it loads no other URL. So the check decodes each data: SVG as Chrome's
// URL and fetch code does (base64 or percent-encoding, the fragment cut at
// the first #, tab and newlines dropped, the MIME type's essence) and reads
// it as an SVG file, nesting bounded; a data: stylesheet is refused as in a
// template (asset-data).
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

const svgFile = 'assets/figure.svg';
const ns = 'xmlns="http://www.w3.org/2000/svg"';

const gradient = (spread: string) =>
  `<defs><linearGradient id="g" x2="4" spreadMethod="${spread}"><stop offset="0.5" stop-color="#000"/><stop offset="0.5" stop-color="#fff"/></linearGradient></defs><rect width="40" height="10" fill="url(#g)"/>`;
const svg = (inner: string, prolog = '') =>
  `${prolog}<svg ${ns} viewBox="0 0 40 10">${inner}</svg>`;
const repeat = svg(gradient('repeat'));
const pad = svg(gradient('pad'));

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const percent = (text: string) => encodeURIComponent(text);
/** XML attribute text for `value` in double quotes. */
const attr = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');

function pack(file: string | Uint8Array): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'svg-data-url',
      name: 'SVG data URLs',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: 'report.hbs',
        styles: [],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [svgFile],
      },
    }),
    'report.hbs': withHead(
      `<img data-gt="image" src="${svgFile}" alt="" width="40" height="10"><p data-gt="paragraph">{{value}}</p>`,
    ),
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
    [svgFile]: file,
  };
}

function position(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Refused with exactly one `code` issue, in the SVG file at the first
 * occurrence of `at`, whose message names the data:image/svg+xml image.
 */
function refusedAt(file: string, at: string, code = 'css-repeating-gradient') {
  const result = checkPack(pack(file));
  expect.soft(result.ok).toBe(false);
  const offset = file.indexOf(at);
  expect(offset, `${at} in ${file}`).toBeGreaterThanOrEqual(0);
  expect(result.issues.filter(issue => issue.code === code)).toEqual([
    {
      code,
      file: svgFile,
      ...position(file, offset),
      message: expect.stringMatching(
        code === 'asset-data' ? /\S/ : /data:image\/svg\+xml/i,
      ),
    },
  ]);
}

const accepted = (file: string) =>
  expect(checkPack(pack(file))).toMatchObject({ ok: true, issues: [] });

/** An SVG file showing `url` as an <image>. */
const image = (url: string, name = 'href') =>
  svg(`<image ${name}="${attr(url)}" width="40" height="10"/>`);

describe('data:image/svg+xml inside SVG files', () => {
  it.each([
    ['base64', `data:image/svg+xml;base64,${base64(repeat)}`],
    ['percent-encoded', `data:image/svg+xml,${percent(repeat)}`],
    [
      'raw, with no # before the gradient',
      `data:image/svg+xml;utf8,<svg ${ns}><defs><linearGradient id="g" x2="4" spreadMethod="repeat"><stop offset="0.5" stop-color="black"/></linearGradient></defs></svg>`,
    ],
    ['upper case', `DATA:IMAGE/SVG+XML;BASE64,${base64(repeat)}`],
    [
      'a charset parameter',
      `data:image/svg+xml;charset=utf-8;base64,${base64(repeat)}`,
    ],
    [
      'spaces in the base64 and around the URL',
      `  data:image/svg+xml;base64,${base64(repeat).replace(/(.{8})/g, '$1 ')}  `,
    ],
  ])('refuses a repeat gradient in a %s <image href>, at the URL', (_, url) => {
    const file = image(url);
    refusedAt(
      file,
      url
        .trimStart()
        .slice(0, 5)
        .replace(/[\t\n]/g, ''),
    );
  });

  it('refuses one with a tab and a newline the URL parser drops (as character references)', () => {
    // A literal tab or newline in an XML attribute value is read as a space,
    // which the URL parser keeps; &#9; and &#10; stay a tab and a newline.
    const encoded = base64(repeat);
    const file = svg(
      `<image href="data:image/svg+xml;ba&#9;se64,${encoded.slice(0, 4)}&#10;${encoded.slice(4)}" width="40" height="10"/>`,
    );
    refusedAt(file, 'data:');
  });

  it('accepts one a literal tab breaks (XML reads it as a space)', () => {
    const file = svg(
      `<image href="data:image/svg+xml;ba\tse64,${base64(repeat)}" width="40" height="10"/>`,
    );
    accepted(file);
  });

  it('refuses one whose base64 padding has a space in it (removed first)', () => {
    // Pad the document so its base64 ends in "==", then split the padding.
    const length = new TextEncoder().encode(repeat).length;
    const text = `${repeat}${' '.repeat((4 - (length % 3)) % 3)}`;
    const encoded = base64(text);
    expect(encoded.endsWith('==')).toBe(true);
    const url = `data:image/svg+xml;base64,${encoded.slice(0, -1)} =`;
    refusedAt(image(url), url);
  });

  it('refuses one in xlink:href', () => {
    const url = `data:image/svg+xml;base64,${base64(repeat)}`;
    const file = image(url, 'xlink:href').replace(
      '<svg ',
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ',
    );
    refusedAt(file, url);
  });

  it.each([
    [
      'an XHTML <img src>',
      (url: string) =>
        `<foreignObject width="40" height="10"><img xmlns="http://www.w3.org/1999/xhtml" src="${attr(url)}"/></foreignObject>`,
    ],
    [
      'a style attribute url()',
      (url: string) =>
        `<foreignObject width="40" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="${attr(`background:url('${url}')`)}"></div></foreignObject>`,
    ],
    [
      'a <style> url()',
      (url: string) => `<style>div { background: url("${url}"); }</style>`,
    ],
    [
      'an image-set() string in <style>',
      (url: string) =>
        `<style>div { background: image-set("${url}" 1x); }</style>`,
    ],
  ])('refuses one in %s, at the URL', (_, place) => {
    const url = `data:image/svg+xml;base64,${base64(repeat)}`;
    refusedAt(svg(place(url)), url);
  });

  it('points at the URL as written when a character reference starts it', () => {
    const url = `data:image/svg+xml;base64,${base64(repeat)}`;
    const file = svg(
      `<image href="&#100;${url.slice(1)}" width="1" height="1"/>`,
    );
    refusedAt(file, '&#100;');
  });

  it('refuses a nested one, at the outer URL', () => {
    const inner = `data:image/svg+xml;base64,${base64(repeat)}`;
    const outer = `data:image/svg+xml,${percent(image(inner))}`;
    refusedAt(image(outer), outer);
  });

  it('cuts the URL at its first # as Chrome does (the rest is a fragment)', () => {
    const raw = `data:image/svg+xml,<svg ${ns}><desc>#</desc>${gradient('repeat')}</svg>`;
    accepted(image(raw));
    // Percent-encoded, the # is part of the document.
    const encoded = `data:image/svg+xml,${percent(`<svg ${ns}><desc>#</desc>${gradient('repeat')}</svg>`)}`;
    refusedAt(image(encoded), encoded);
  });

  it.each([
    ['a pad gradient', `data:image/svg+xml;base64,${base64(pad)}`],
    ['data:text/xml', `data:text/xml;base64,${base64(repeat)}`],
    ['no MIME type', `data:;base64,${base64(repeat)}`],
    ['image/png', `data:image/png;base64,${base64(repeat)}`],
    ['a longer subtype', `data:image/svg+xml-extra;base64,${base64(repeat)}`],
  ])('accepts %s', (_, url) => {
    accepted(image(url));
  });

  it.each([
    [
      'a DOCTYPE internal subset',
      svg(gradient('pad'), '<!DOCTYPE svg [<!ENTITY x "y">]>'),
      'html-unsupported',
    ],
    ['a NUL', `${pad}\0`, 'text-encoding'],
  ])('reports %s inside one at the URL', (_, inner, code) => {
    const url = `data:image/svg+xml;base64,${base64(inner)}`;
    refusedAt(image(url), url, code);
  });

  it('reports bytes that are not UTF-8 at the URL', () => {
    const url = `data:image/svg+xml,${percent(pad)}%FF`;
    refusedAt(image(url), url, 'text-encoding');
  });

  it('reports a charset other than UTF-8 at the URL', () => {
    const url = `data:image/svg+xml;charset=iso-8859-1;base64,${base64(pad)}`;
    refusedAt(image(url), url, 'text-encoding');
  });

  /** `depth` data: SVGs, each inside the previous, the innermost `last`. */
  const nested = (depth: number, last: string) => {
    let url = `data:image/svg+xml;base64,${base64(last)}`;
    for (let level = 1; level < depth; level++) {
      url = `data:image/svg+xml;base64,${base64(image(url))}`;
    }
    return url;
  };

  it('reads data: SVGs nested 8 deep', () => {
    const url = nested(8, repeat);
    refusedAt(image(url), url);
    accepted(image(nested(8, pad)));
  });

  it('refuses data: SVGs nested 9 deep, at the outer URL', () => {
    const url = nested(9, pad);
    refusedAt(image(url), url, 'pack-too-complex');
  });
});

describe('data: stylesheets inside SVG files', () => {
  const black = `data:text/css,${percent('rect { fill: #000; }')}`;

  it.each([
    [
      'an xml-stylesheet processing instruction',
      `<?xml-stylesheet type="text/css" href="${black}"?>\n${pad}`,
    ],
    ['an @import in <style>', svg(`<style>@import url("${black}");</style>`)],
    [
      'an XHTML <link>',
      svg(
        `<foreignObject width="40" height="10"><link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" href="${black}"/></foreignObject>`,
      ),
    ],
  ])('refuses %s (Chrome applies it), at the URL', (_, file) => {
    refusedAt(file, black, 'asset-data');
  });

  it('refuses an xml-stylesheet href a character reference starts (Chrome decodes it)', () => {
    const file = `<?xml-stylesheet type="text/css" href="&#100;${black.slice(1)}"?>\n${pad}`;
    refusedAt(file, '&#100;', 'asset-data');
  });

  it('refuses an xml-stylesheet of a pack file as asset-svg-nested (an SVG image loads it not, T06-16)', () => {
    const file = `<?xml-stylesheet type="text/css" href="style.css"?>\n${pad}`;
    expect(checkPack(pack(file)).issues).toEqual([
      {
        code: 'asset-svg-nested',
        file: svgFile,
        ...position(file, file.indexOf('style.css')),
        message: expect.stringMatching(/\S/),
      },
    ]);
  });
});

describe('data: URLs inside SVG files: linear time', () => {
  const fastest = (files: PackFiles) => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      checkPack(files);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const size = 64 * 1024;
  const fill = (unit: string) =>
    unit.repeat(Math.floor((size - 200) / unit.length));
  const plain = svg(fill('<rect width="1" height="1"/>'));
  const small = `data:image/svg+xml;base64,${base64(pad)}`;

  it.each([
    ['many data: images', svg(fill(`<image href="${small}"/>`))],
    [
      'many data: URLs in one style',
      svg(`<g style="${fill(`background:url(${small});`)}"/>`),
    ],
    ['percent signs', svg(`<image href="data:image/svg+xml,${fill('%%2')}"/>`)],
    [
      'one image nested 8 deep, padded to 64 KiB',
      (() => {
        let url = `data:image/svg+xml,${percent(svg(`<desc>${fill('x').slice(0, 8000)}</desc>`))}`;
        for (let level = 1; level < 8; level++) {
          url = `data:image/svg+xml;base64,${base64(image(url))}`;
        }
        return image(url);
      })(),
    ],
  ])('reads 64 KiB of %s about as fast as plain markup', (_, file) => {
    checkPack(pack(file));
    const base = fastest(pack(plain));
    const crafted = fastest(pack(file));
    expect(crafted).toBeLessThan(Math.max(base, 1) * 50);
  });
});
