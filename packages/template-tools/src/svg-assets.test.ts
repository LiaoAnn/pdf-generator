// T06-13: an .svg file of the pack prints as an image (<img>, CSS url(),
// SVG <image>), and inside that image Chrome still prints a repeating
// gradient as the shading pdf.js misreads: spreadMethod="repeat"/"reflect"
// and CSS repeating-*-gradient() (in foreignObject HTML) measured 0.05 in
// pdf.js against PDFium's 0.50 (T06-13 probe). Chrome reads the file as XML:
// character references, DTD internal subsets (entities, ATTLIST defaults),
// SMIL <set>, prefixed SVG elements and CDATA all take effect, and a UTF-16
// file with a BOM renders, so the check reads what Chrome reads. Scripts and
// nested file loads do nothing in an image, so those template rules don't
// apply inside an SVG file.
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

const code = 'css-repeating-gradient';
const svgFile = 'assets/figure.svg';
const ns = 'xmlns="http://www.w3.org/2000/svg"';

/** A gradient (start tag given) with two stops, used by a rect. */
const drawing = (gradient: string, end = 'linearGradient') =>
  `<defs>${gradient}<stop offset="0.5" stop-color="#000"/><stop offset="0.5" stop-color="#fff"/></${end}></defs><rect width="40" height="10" fill="url(#g)"/>`;

const svg = (inner: string, prolog = '') =>
  `${prolog}<svg ${ns} viewBox="0 0 40 10">${inner}</svg>`;

function pack(
  assets: Record<string, string | Uint8Array>,
  template = `<img data-gt="image" src="${Object.keys(assets)[0] ?? ''}" alt="" width="40" height="10">`,
): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'svg-assets',
      name: 'SVG assets',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: 'report.hbs',
        styles: [],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: Object.keys(assets),
      },
    }),
    'report.hbs': withHead(`${template}<p data-gt="paragraph">{{value}}</p>`),
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
    ...assets,
  };
}

/** Line and column (1-based) of `offset` in `text`. */
function position(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

const byPlace = (
  a: { line?: number; column?: number },
  b: { line?: number; column?: number },
) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);

/**
 * Refused with exactly one `issueCode` issue in `file` per token, in document
 * order, each at the token's first occurrence after the previous one.
 */
function refused(
  files: PackFiles,
  tokens: string[],
  { file = svgFile, issueCode = code } = {},
) {
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
      code: issueCode,
      file,
      ...position(text, offset),
      message: expect.stringMatching(/\S/),
    };
  });
  expect(
    result.issues
      .filter(issue => issue.code === issueCode && issue.file === file)
      .sort(byPlace),
  ).toEqual(expected);
  return result;
}

/** Refused with one file-level `issueCode` issue for `file`. */
function refusedFile(files: PackFiles, issueCode: string, file = svgFile) {
  const result = checkPack(files);
  expect.soft(result.ok).toBe(false);
  expect(result.issues.filter(issue => issue.code === issueCode)).toEqual([
    expect.objectContaining({
      code: issueCode,
      file,
      message: expect.stringMatching(/\S/),
    }),
  ]);
}

const accepted = (files: PackFiles) =>
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });

const stripes = 'repeating-linear-gradient(90deg, #000 0 2px, #fff 2px 4px)';

describe('SVG files: spreadMethod', () => {
  it.each([
    [
      'repeat on linearGradient',
      drawing('<linearGradient id="g" x2="4" spreadMethod="repeat">'),
      ['spreadMethod'],
    ],
    [
      'reflect on radialGradient',
      drawing(
        '<radialGradient id="g" r="2" spreadMethod="reflect">',
        'radialGradient',
      ),
      ['spreadMethod'],
    ],
    [
      'a character reference in the value',
      drawing('<linearGradient id="g" x2="4" spreadMethod="&#114;epeat">'),
      ['spreadMethod'],
    ],
    [
      'a hex character reference in the value',
      drawing("<linearGradient id='g' x2='4' spreadMethod='&#x72;eflect'>"),
      ['spreadMethod'],
    ],
    [
      'a character reference with leading zeros (XML allows any number)',
      drawing(
        `<linearGradient id="g" x2="4" spreadMethod="&#${'0'.repeat(40)}114;epeat">`,
      ),
      ['spreadMethod'],
    ],
    [
      'a value split over lines (XML normalizes the whitespace)',
      drawing('<linearGradient\n  id="g"\n  x2="4"\n  spreadMethod="repeat">'),
      ['spreadMethod'],
    ],
  ])('refuses %s, at the attribute', (_, inner, tokens) => {
    refused(pack({ [svgFile]: svg(inner) }), tokens);
  });

  it('refuses a prefixed SVG gradient (Chrome reads XML namespaces)', () => {
    const file = `<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><s:defs><s:linearGradient id="g" x2="4" spreadMethod="repeat"><s:stop offset="0.5" stop-color="#000"/></s:linearGradient></s:defs><s:rect width="40" height="10" fill="url(#g)"/></s:svg>`;
    refused(pack({ [svgFile]: file }), ['spreadMethod']);
  });

  it.each([
    [
      '<set to="repeat">',
      '<set href="#g" attributeName="spreadMethod" to="repeat"/>',
    ],
    [
      '<animate values="…;reflect">',
      '<animate href="#g" attributeName="spreadMethod" values="pad;reflect" dur="1s"/>',
    ],
  ])('refuses SMIL %s of spreadMethod, at the element', (_, smil) => {
    const inner = `${drawing('<linearGradient id="g" x2="4">')}${smil}`;
    refused(pack({ [svgFile]: svg(inner) }), [smil.slice(0, 4)]);
  });

  it('reports each gradient once, in document order, across lines', () => {
    const inner = [
      drawing('<linearGradient id="g" x2="4" spreadMethod="repeat">'),
      drawing(
        '<radialGradient id="h" r="2" spreadMethod="reflect">',
        'radialGradient',
      ),
    ].join('\n');
    refused(pack({ [svgFile]: svg(inner) }), ['spreadMethod', 'spreadMethod']);
  });

  it('names the alternatives in the message', () => {
    const result = checkPack(
      pack({
        [svgFile]: svg(
          drawing('<linearGradient id="g" x2="4" spreadMethod="repeat">'),
        ),
      }),
    );
    const issue = result.issues.find(i => i.code === code);
    expect(issue?.message).toMatch(/<rect>/);
    expect(issue?.message).toMatch(/4pt 100%/);
  });

  it.each([
    ['pad', drawing('<linearGradient id="g" x2="40" spreadMethod="pad">')],
    ['no spreadMethod', drawing('<linearGradient id="g" x2="40">')],
    [
      'spreadMethod in a comment',
      `<!-- <linearGradient spreadMethod="repeat"> -->${drawing('<linearGradient id="g" x2="40">')}`,
    ],
    [
      'spreadMethod in text',
      `<desc>spreadMethod="repeat"</desc>${drawing('<linearGradient id="g" x2="40">')}`,
    ],
    [
      'spreadMethod in CDATA text',
      `<desc><![CDATA[<linearGradient spreadMethod="repeat">]]></desc>${drawing('<linearGradient id="g" x2="40">')}`,
    ],
    [
      'SMIL of another attribute',
      `${drawing('<linearGradient id="g" x2="40">')}<set href="#g" attributeName="x2" to="4"/>`,
    ],
  ])('accepts %s', (_, inner) => {
    accepted(pack({ [svgFile]: svg(inner) }));
  });
});

describe('SVG files: CSS repeating gradients', () => {
  const html = (style: string) =>
    `<foreignObject width="40" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="${style}"></div></foreignObject>`;

  it.each([
    [
      'a <style> element',
      `<style>div { background: ${stripes}; }</style>${html('width:40px;height:10px')}`,
      ['repeating-linear-gradient'],
    ],
    [
      'a <style> element in CDATA',
      `<style><![CDATA[ div { background: ${stripes}; } ]]></style>${html('width:40px')}`,
      ['repeating-linear-gradient'],
    ],
    [
      'a style attribute in foreignObject HTML',
      html(`width:40px;height:10px;background:${stripes}`),
      ['repeating-linear-gradient'],
    ],
    [
      'repeating-radial-gradient, prefixed and in another case',
      html(
        'background:-webkit-Repeating-Radial-Gradient(circle, #000 0 2px, #fff 2px 4px)',
      ),
      ['-webkit-Repeating-Radial-Gradient'],
    ],
    [
      'a CSS escape in the name',
      `<style>div { background: repeating-linear-gradi\\65nt(red, blue); }</style>`,
      ['repeating-linear-gradi'],
    ],
    [
      'an SVG presentation attribute',
      `<rect width="40" height="10" fill="${stripes}"/>`,
      ['repeating-linear-gradient'],
    ],
  ])('refuses %s, at the function', (_, inner, tokens) => {
    refused(pack({ [svgFile]: svg(inner) }), tokens);
  });

  it('refuses a name a character reference spells in <style>, at its start', () => {
    const inner = `<style>div { background: repeating&#45;linear-gradient(red, blue); }</style>`;
    refused(pack({ [svgFile]: svg(inner) }), ['repeating&#45;']);
  });

  it('decodes named references: &apos; can end a CSS string', () => {
    const inner = `<foreignObject width="40" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="content:'&apos;;background:${stripes}"></div></foreignObject>`;
    refused(pack({ [svgFile]: svg(inner) }), ['repeating-linear-gradient']);
  });

  it('refuses a name split by CDATA and a comment in <style> (Chrome joins the text)', () => {
    const inner = `<style>div { background: repeating-<![CDATA[linear-]]><!-- x -->gradient(red, blue); }</style>`;
    refused(pack({ [svgFile]: svg(inner) }), ['repeating-<![CDATA[']);
  });

  it.each([
    [
      'css-escape for an escape in <style>',
      `<style>div { background: url(da\\74 a:x); }</style>`,
      'css-escape',
      '\\74',
    ],
    [
      'asset-dynamic for var() in image-set() in a style attribute',
      `<foreignObject width="40" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="background:image-set(var(--x) 1x)"></div></foreignObject>`,
      'asset-dynamic',
      'var(',
    ],
  ])(
    'refuses %s (they keep the URL reading sound)',
    (_, inner, issueCode, at) => {
      refused(pack({ [svgFile]: svg(inner) }), [at], { issueCode });
    },
  );

  it('accepts editor metadata in prefixed attributes (not CSS to Chrome)', () => {
    const file = `<svg ${ns} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:export-filename="C:\\Users\\designer\\logo.png" inkscape:label="repeating-linear-gradient(x)" viewBox="0 0 40 10"><rect width="40" height="10" fill="#000"/></svg>`;
    accepted(pack({ [svgFile]: file }));
  });

  it.each([
    ['in an XML comment', `<!-- <style>div{background:${stripes}}</style> -->`],
    ['in <text>', `<text y="8">${stripes}</text>`],
    [
      'in a CSS comment',
      `<style>/* ${stripes} */ rect { fill: #000; }</style>`,
    ],
    [
      'in a CSS string',
      `<style>div::before { content: "${stripes}"; }</style>`,
    ],
    [
      'linear-gradient and radial-gradient',
      html(
        'background:linear-gradient(90deg,#000,#fff),radial-gradient(#000,#fff)',
      ),
    ],
  ])('accepts a repeating gradient %s', (_, inner) => {
    accepted(pack({ [svgFile]: svg(inner) }));
  });
});

describe('SVG files: which files and what Chrome reads', () => {
  const repeat = svg(
    drawing('<linearGradient id="g" x2="4" spreadMethod="repeat">'),
  );

  it('checks an .svg file in another case (print serves it as SVG)', () => {
    refused(pack({ 'assets/LOGO.SVG': repeat }), ['spreadMethod'], {
      file: 'assets/LOGO.SVG',
    });
  });

  it('checks an asset no template references (it is still in the pack)', () => {
    refused(pack({ [svgFile]: repeat }, '<p data-gt="paragraph">x</p>'), [
      'spreadMethod',
    ]);
  });

  it('checks an SVG file used as a CSS background', () => {
    refused(
      pack(
        { [svgFile]: repeat },
        `<div data-gt="image" style="width:40px;height:10px;background:url(${svgFile})"></div>`,
      ),
      ['spreadMethod'],
    );
  });

  it('checks every SVG file, each in its own place', () => {
    const files = pack({ 'assets/a.svg': repeat, 'assets/b.svg': repeat });
    refused(files, ['spreadMethod'], { file: 'assets/a.svg' });
    refused(files, ['spreadMethod'], { file: 'assets/b.svg' });
  });

  it('accepts a file whose name only contains .svg', () => {
    accepted(
      pack({ 'assets/notes.svg.txt': repeat }, '<p data-gt="paragraph">x</p>'),
    );
  });

  it.each([
    ['an <!ENTITY> declaration', '<!DOCTYPE svg [<!ENTITY rep "repeat">]>\n'],
    [
      'an <!ATTLIST> default',
      '<!DOCTYPE svg [<!ATTLIST linearGradient spreadMethod CDATA "repeat">]>\n',
    ],
    ['an empty internal subset', '<!DOCTYPE svg []>\n'],
    [
      'an internal subset after a quoted external id',
      '<!DOCTYPE svg SYSTEM "a>b.dtd" [<!ENTITY x "y">]>\n',
    ],
  ])(
    'refuses a DOCTYPE internal subset (%s): Chrome applies it',
    (_, prolog) => {
      const file = svg(drawing('<linearGradient id="g" x2="40">'), prolog);
      refused(pack({ [svgFile]: file }), ['<!DOCTYPE'], {
        issueCode: 'html-unsupported',
      });
    },
  );

  it.each([
    [
      'the SVG 1.1 public DOCTYPE',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n',
    ],
    ['a quoted [ in the external id', '<!DOCTYPE svg SYSTEM "a[b.dtd">\n'],
    [
      'an XML declaration naming UTF-8',
      '<?xml version="1.0" encoding="UTF-8"?>\n',
    ],
    ["a lower-case 'utf-8'", "<?xml version='1.0' encoding='utf-8'?>\n"],
    ['a UTF-8 byte order mark', '﻿'],
  ])('accepts %s', (_, prolog) => {
    accepted(
      pack({
        [svgFile]: svg(drawing('<linearGradient id="g" x2="40">'), prolog),
      }),
    );
  });

  it('refuses a UTF-16 file (with a BOM Chrome renders it)', () => {
    const units = new Uint16Array([
      0xfeff,
      ...[...repeat].map(c => c.charCodeAt(0)),
    ]);
    refusedFile(
      pack({ [svgFile]: new Uint8Array(units.buffer) }),
      'text-encoding',
    );
  });

  it('refuses bytes that are not UTF-8', () => {
    const bytes = new TextEncoder().encode(repeat);
    refusedFile(
      pack({ [svgFile]: Uint8Array.from([...bytes, 0xff, 0xfe]) }),
      'text-encoding',
    );
  });

  it('refuses a NUL character (another encoding read as UTF-8)', () => {
    refusedFile(pack({ [svgFile]: `${repeat}\0` }), 'text-encoding');
  });

  it('refuses an XML declaration naming another encoding', () => {
    const file = svg(
      drawing('<linearGradient id="g" x2="40">'),
      '<?xml version="1.0" encoding="ISO-8859-1"?>\n',
    );
    refusedFile(pack({ [svgFile]: file }), 'text-encoding');
  });

  it('accepts scripts and nested file references (an SVG image runs and loads nothing)', () => {
    const file = svg(
      `<rect id="r" width="40" height="10" fill="#fff"/><script>document.getElementById('r').setAttribute('fill','#000')</script><image href="missing.png" width="1" height="1"/><style>@import url(missing.css);</style>`,
    );
    accepted(pack({ [svgFile]: file }));
  });
});

describe('SVG files: linear time', () => {
  /** The fastest of three runs of checkPack, in ms. */
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
  const baseline = svg(fill('<rect width="1" height="1"/>'));

  it.each([
    ['nested elements', svg(`${fill('<g>')}`).replace('</svg>', '')],
    ['unclosed comments', svg(fill('<!--x'))],
    ['unclosed CDATA', svg(fill('<![CDATA[x'))],
    ['unterminated attribute values', svg(fill('<g a="'))],
    ['character references', svg(`<desc>${fill('&#')}</desc>`)],
    ['DOCTYPE brackets', `<!DOCTYPE svg ${fill('"[')}`],
    ['style text chunks', svg(`<style>${fill('a<![CDATA[b]]>')}</style>`)],
    ['attributes', svg(`<g ${fill('a="b" ')}/>`)],
    [
      'a srcset comma run followed by more URL',
      svg(`<image srcset="x${fill(',')}x,"/>`),
    ],
  ])('reads 64 KiB of %s about as fast as plain markup', (_, file) => {
    const files = pack({ [svgFile]: file });
    const plain = pack({ [svgFile]: baseline });
    checkPack(files);
    const base = fastest(plain);
    const crafted = fastest(files);
    // Linear readers stay within a small factor of the plain file; a
    // rescan from each `<`, `&` or `[` is thousands of times slower at 64 KiB.
    expect(crafted).toBeLessThan(Math.max(base, 1) * 50);
  });

  it('reads a 64 KiB <style> of character references', () => {
    const css = `rect { fill: #000; }${'&#32;'.repeat(12_000)}`;
    accepted(pack({ [svgFile]: svg(`<style>${css}</style>`) }));
  });

  it('accepts 16,000 nested elements without a stack overflow', () => {
    const depth = 16_000;
    accepted(
      pack({ [svgFile]: svg(`${'<g>'.repeat(depth)}${'</g>'.repeat(depth)}`) }),
    );
  });
});
