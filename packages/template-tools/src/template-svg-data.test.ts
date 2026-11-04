// T06-13: a data:image/svg+xml image in the template or a stylesheet prints
// like an SVG file (the probe: <img src>, CSS background url(), base64 and
// percent-encoded, all misread a repeat gradient). The upload reads each one
// as an SVG file and reports what it finds at the URL.
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

const templateFile = 'report.hbs';
const styleFile = 'styles/main.css';
const ns = 'xmlns="http://www.w3.org/2000/svg"';

const gradient = (spread: string) =>
  `<defs><linearGradient id="g" x2="4" spreadMethod="${spread}"><stop offset="0.5" stop-color="#000"/><stop offset="0.5" stop-color="#fff"/></linearGradient></defs><rect width="40" height="10" fill="url(#g)"/>`;
const svg = (inner: string, prolog = '') =>
  `${prolog}<svg ${ns} viewBox="0 0 40 10">${inner}</svg>`;
const repeat = svg(gradient('repeat'));
const pad = svg(gradient('pad'));
const stripes = `<svg ${ns}><foreignObject width="40" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="background:repeating-linear-gradient(90deg,black 0 2px,white 2px 4px)"></div></foreignObject></svg>`;

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const percent = (text: string) => encodeURIComponent(text);
const b64Url = (text: string) => `data:image/svg+xml;base64,${base64(text)}`;

function pack(body: string, css = ''): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'template-svg-data',
      name: 'Template SVG data URLs',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [styleFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [],
      },
    }),
    [templateFile]: withHead(`${body}<p data-gt="paragraph">{{value}}</p>`),
    [styleFile]: css,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
  };
}

function position(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Refused with exactly one `code` issue, in `file` at the first occurrence of
 * `at`, whose message names the data:image/svg+xml image.
 */
function refusedAt(
  files: PackFiles,
  at: string,
  { file = templateFile, code = 'css-repeating-gradient' } = {},
) {
  const result = checkPack(files);
  expect.soft(result.ok).toBe(false);
  const text = String(files[file]);
  const offset = text.indexOf(at);
  expect(offset, `${at} in ${text}`).toBeGreaterThanOrEqual(0);
  expect(result.issues.filter(issue => issue.code === code)).toEqual([
    {
      code,
      file,
      ...position(text, offset),
      message: expect.stringMatching(/data:image\/svg\+xml/i),
    },
  ]);
}

const accepted = (files: PackFiles) =>
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });

describe('data:image/svg+xml in the template', () => {
  it.each([
    [
      '<img src>, base64',
      (url: string) => `<img data-gt="image" src="${url}" alt="">`,
      b64Url(repeat),
    ],
    [
      '<img src>, percent-encoded',
      (url: string) => `<img data-gt="image" src="${url}" alt="">`,
      `data:image/svg+xml,${percent(repeat)}`,
    ],
    [
      'the second srcset candidate',
      (url: string) =>
        `<img data-gt="image" src="${b64Url(pad)}" srcset="${b64Url(pad)} 1x, ${url} 2x" alt="">`,
      b64Url(repeat),
    ],
    [
      '<picture><source srcset>',
      (url: string) =>
        `<picture data-gt="image"><source srcset="${url}"><img src="${b64Url(pad)}" alt=""></picture>`,
      b64Url(repeat),
    ],
    [
      'an inline SVG <image href>',
      (url: string) =>
        `<svg data-gt="image" viewBox="0 0 40 10"><image href="${url}" width="40" height="10"/></svg>`,
      b64Url(repeat),
    ],
    [
      'a style attribute url()',
      (url: string) =>
        `<div data-gt="image" style="background:url('${url}')"></div>`,
      b64Url(repeat),
    ],
    [
      'a <style> url()',
      (url: string) =>
        `<style>.x { background: url(${url}); }</style><div class="x" data-gt="image"></div>`,
      b64Url(repeat),
    ],
    [
      'a CSS repeating gradient inside the image',
      (url: string) => `<img data-gt="image" src="${url}" alt="">`,
      b64Url(stripes),
    ],
  ])('refuses %s, at the URL', (_, place, url) => {
    refusedAt(pack(place(url)), url);
  });

  it('points at the URL as written when the attribute uses entities', () => {
    // &lt; and &quot; decode to the raw SVG Chrome reads (no # in it).
    const raw = `data:image/svg+xml,<svg ${ns}><defs><linearGradient id="g" x2="4" spreadMethod="repeat"><stop offset="0.5" stop-color="black"/></linearGradient></defs></svg>`;
    const written = raw.replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const files = pack(
      `<img data-gt="image" alt="" src="&#x64;${written.slice(1)}">`,
    );
    refusedAt(files, '&#x64;');
  });

  it('reports what the SVG holds, located at the URL', () => {
    const url = b64Url(
      svg(gradient('pad'), '<!DOCTYPE svg [<!ENTITY x "y">]>'),
    );
    refusedAt(pack(`<img data-gt="image" src="${url}" alt="">`), url, {
      code: 'html-unsupported',
    });
  });

  it.each([
    ['a pad gradient', b64Url(pad)],
    ['a PNG', `data:image/png;base64,${base64(repeat)}`],
    ['text/xml', `data:text/xml;base64,${base64(repeat)}`],
  ])('accepts %s', (_, url) => {
    accepted(pack(`<img data-gt="image" src="${url}" alt="">`));
  });
});

describe('data:image/svg+xml in stylesheets', () => {
  const box = '<div class="x" data-gt="image"></div>';

  it.each([
    ['background url()', (url: string) => `.x { background: url("${url}"); }`],
    [
      'an unquoted url()',
      (url: string) => `.x { background-image: url(${url}); }`,
    ],
    [
      'image-set()',
      (url: string) => `.x { background: image-set("${url}" 1x); }`,
    ],
    ['mask-image', (url: string) => `.x { mask-image: url('${url}'); }`],
    [
      'border-image in @media',
      (url: string) =>
        `@media print { .x { border-image: url(${url}) 30 round; } }`,
    ],
    ['a custom property', (url: string) => `:root { --logo: url(${url}); }`],
  ])('refuses one in %s, at the URL', (_, css) => {
    const url = `data:image/svg+xml,${percent(repeat)}`;
    refusedAt(pack(box, css(url)), url, { file: styleFile });
  });

  it('accepts a pad gradient', () => {
    accepted(pack(box, `.x { background: url("${b64Url(pad)}"); }`));
  });
});
