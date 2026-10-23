import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { checkPack, type PackFiles } from './index.ts';

const templateFile = 'templates/report.hbs';
const cssFile = 'styles/base.css';
const markedText = '<p data-gt="paragraph">{{holder}}</p>';

function validFiles(
  template = markedText,
  css = 'body { color: black; }',
): PackFiles {
  const assets = {
    'assets/logo.png': new Uint8Array([0x89, 0x50, 0xff]),
    'assets/a b.png': new Uint8Array([0x89, 0x50, 0xfe]),
    'assets/fonts/Body.woff2': new Uint8Array([0x77, 0x4f, 0xff]),
    'assets/fonts/Bold.woff2': new Uint8Array([0x77, 0x4f, 0xfe]),
    'assets/unused.bin': new Uint8Array([0xff, 0xfe]),
  };
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    id: 'asset-report',
    name: '素材測試',
    page: { size: 'A4', orientation: 'portrait' },
    files: {
      template: templateFile,
      styles: [cssFile, 'styles/extra.css'],
      rules: 'data/rules.json',
      sample: 'data/sample.json',
      assets: Object.keys(assets),
    },
  });
  const rules = rulesSchema.parse({
    schemaVersion: 1,
    fields: { holder: { type: 'name' } },
  });
  const sample = recordSchema(rules).parse({ holder: '王小明' });
  return {
    'manifest.json': JSON.stringify(manifest),
    [templateFile]: template,
    [cssFile]: css,
    'styles/extra.css': '',
    'data/rules.json': JSON.stringify(rules),
    'data/sample.json': JSON.stringify(sample),
    ...assets,
  };
}

// Locate the chosen literal in the source independently of HTML/CSS parsing.
function location(source: string, token: string) {
  const offset = source.indexOf(token);
  expect(offset, `fixture contains ${token}`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function rejected(
  files: PackFiles,
  file: string,
  code: string,
  token: string,
  resolved?: string,
) {
  const result = checkPack(files);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]).toMatchObject({
    code,
    file,
    ...location(String(files[file]), token),
  });
  expect(result.issues[0]?.message.trim().length).toBeGreaterThan(0);
  if (resolved !== undefined)
    expect(result.issues[0]?.message).toContain(resolved);
}

function accepted(files: PackFiles) {
  const result = checkPack(files);
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.pack).toBeDefined();
}

describe('checkPack template asset references', () => {
  it.each([
    'img',
    'source',
    'video',
    'audio',
    'iframe',
    'embed',
    'script',
    'input',
  ])('rejects a missing %s src instead of checking only img', tag => {
    const template = `<section data-gt="paragraph">\n<${tag}\n  src="../assets/missing.png"></${tag}>\n</section>`;
    rejected(
      validFiles(template),
      templateFile,
      'asset-missing',
      '../assets/missing.png',
      'assets/missing.png',
    );
  });

  it.each([
    [
      'video poster',
      '<video data-gt="image" poster="../assets/missing.png"></video>',
    ],
    [
      'object data',
      '<object data-gt="image" data="../assets/missing.png"></object>',
    ],
    ['link href', '<link href="../assets/missing.png" rel="stylesheet">'],
    [
      'svg image href',
      '<svg data-gt="image"><image href="../assets/missing.png"/></svg>',
    ],
    [
      'svg image xlink:href',
      '<svg data-gt="image"><image xlink:href="../assets/missing.png"/></svg>',
    ],
    [
      'svg use href',
      '<svg data-gt="image"><use href="../assets/missing.png"/></svg>',
    ],
    [
      'svg use xlink:href',
      '<svg data-gt="image"><use xlink:href="../assets/missing.png"/></svg>',
    ],
    [
      'style attribute URL',
      '<p data-gt="paragraph" style="background: url(\'../assets/missing.png\')">{{holder}}</p>',
    ],
    [
      'style element URL',
      '<style>\np { background: url("../assets/missing.png"); }\n</style>',
    ],
  ])(
    'rejects a missing %s at the URL rather than the element',
    (_name, template) => {
      rejected(
        validFiles(template),
        templateFile,
        'asset-missing',
        '../assets/missing.png',
        'assets/missing.png',
      );
    },
  );

  it.each(['img', 'source'])(
    'locates only the second missing %s srcset candidate',
    tag => {
      const template = `<section data-gt="image">\n<${tag} srcset="../assets/logo.png 1x,\n    ../assets/missing.png 2x">\n</section>`;
      rejected(
        validFiles(template),
        templateFile,
        'asset-missing',
        '../assets/missing.png',
        'assets/missing.png',
      );
    },
  );

  it.each([
    'https://cdn.example/logo.png',
    'http://cdn.example/logo.png',
    'file:///tmp/logo.png',
    'blob:logo',
    '//cdn.example/logo.png',
  ])(
    'rejects external template reference %s even when it is not https',
    url => {
      rejected(
        validFiles(`<img data-gt="image"\n  src="${url}">`),
        templateFile,
        'asset-external',
        url,
      );
    },
  );

  it.each(['/assets/logo.png', '../../logo.png', '%2e%2e/%2e%2e/logo.png'])(
    'rejects template path %s that cannot stay inside the pack',
    url => {
      rejected(
        validFiles(`<img data-gt="image"\n  src="${url}">`),
        templateFile,
        'asset-path',
        url,
      );
    },
  );
});

describe('checkPack stylesheet asset references', () => {
  it.each([
    ['double-quoted url', 'p { background: url("../assets/missing.png"); }'],
    ['single-quoted url', "p { background: url('../assets/missing.png'); }"],
    ['unquoted url', 'p { background: url(../assets/missing.png); }'],
    ['quoted import', '@import "../assets/missing.png";'],
    ['single-quoted import', "@import '../assets/missing.png';"],
    ['url import', '@import url("../assets/missing.png");'],
  ])(
    'rejects a missing %s resolved relative to styles/base.css',
    (_name, css) => {
      rejected(
        validFiles(markedText, `/* heading\ncomment */\n${css}`),
        cssFile,
        'asset-missing',
        '../assets/missing.png',
        'assets/missing.png',
      );
    },
  );

  it.each([
    'https://cdn.example/body.woff2',
    'http://cdn.example/body.woff2',
    'file:///tmp/body.woff2',
    '//cdn.example/body.woff2',
  ])('rejects external CSS reference %s at its multiline URL', url => {
    rejected(
      validFiles(markedText, `p {\n  background: url(\n    "${url}"\n  );\n}`),
      cssFile,
      'asset-external',
      url,
    );
  });

  it.each(['/assets/logo.png', '../../logo.png'])(
    'rejects CSS path %s instead of resolving it against the pack root',
    url => {
      rejected(
        validFiles(markedText, `p {\n  background: url('${url}');\n}`),
        cssFile,
        'asset-path',
        url,
      );
    },
  );

  it('checks every manifest stylesheet instead of only the first', () => {
    const files = validFiles();
    files['styles/extra.css'] =
      '\np { background: url(../assets/missing.png); }';
    rejected(
      files,
      'styles/extra.css',
      'asset-missing',
      '../assets/missing.png',
      'assets/missing.png',
    );
  });
});

const face = (family: string, url = '../assets/fonts/Body.woff2') =>
  `@font-face { font-family: ${family}; src: url("${url}"); }`;

describe('checkPack unused font families', () => {
  it('rejects a CSS face whose own font-family descriptor is its only use', () => {
    rejected(
      validFiles(
        markedText,
        `/* heading\ncomment */\n  ${face('"Noto Sans TC"')}`,
      ),
      cssFile,
      'font-unused',
      '@font-face',
    );
  });

  it('rejects an unused template style face at the @ rather than its descriptor', () => {
    const template = `<style>\n  ${face('"Noto Sans TC"')}\n</style>\n${markedText}`;
    rejected(validFiles(template), templateFile, 'font-unused', '@font-face');
  });

  it('does not confuse a different family or commented declaration with font usage', () => {
    rejected(
      validFiles(
        markedText,
        `${face('"Noto Sans TC"')}\n/* p { font-family: "Noto Sans TC"; } */\np { font-family: "Noto Sans TC Extra"; }`,
      ),
      cssFile,
      'font-unused',
      '@font-face',
    );
  });

  it('accepts both weights when a case-insensitive family is used via font shorthand in another stylesheet', () => {
    const files = validFiles(
      markedText,
      `${face('"Noto Sans TC"')}\n@font-face { font-family: 'Noto Sans TC'; font-weight: 700; src: url('../assets/fonts/Bold.woff2'); }`,
    );
    files['styles/extra.css'] =
      'p { font: italic 700 12px/1.5 noto sans tc, sans-serif; }';
    accepted(files);
  });

  it('counts a style attribute font-family list as usage of a CSS face', () => {
    accepted(
      validFiles(
        '<p data-gt="paragraph" style="font-family: serif, \'NOTO SANS TC\'">{{holder}}</p>',
        face('"Noto Sans TC"'),
      ),
    );
  });

  it('counts a style attribute font shorthand as usage of a template face', () => {
    accepted(
      validFiles(
        `<style>${face('"Noto Sans TC"')}</style><p data-gt="paragraph" style="font: bold 12pt/1.2 'noto sans tc', serif">{{holder}}</p>`,
      ),
    );
  });

  it('counts template style font-family declarations as usage of a stylesheet face', () => {
    accepted(
      validFiles(
        `<style>p { font-family: noto sans tc; }</style>${markedText}`,
        face('"Noto Sans TC"'),
      ),
    );
  });
});

describe('checkPack self-contained asset acceptance', () => {
  it('accepts images, CSS imports and fonts resolved from their containing files, with unused binary assets allowed', () => {
    accepted(
      validFiles(
        `<link rel="stylesheet" href="../styles/base.css"><img data-gt="image" src="../assets/logo.png">${markedText}`,
        `@import "extra.css";\n${face('"Noto Sans TC"')}\np { font-family: "Noto Sans TC"; background: url(../assets/logo.png); }`,
      ),
    );
  });

  it('decodes percent escapes and drops query and fragment before looking up HTML and CSS assets', () => {
    accepted(
      validFiles(
        '<img data-gt="image" src="../assets/a%20b.png?v=1#preview">',
        'p { background: url("../assets/a%20b.png?v=2#crop"); }',
      ),
    );
  });

  it('ignores CSS comments without shifting the next real reference location', () => {
    const css =
      '/* url(https://cdn.example/ignored.png)\n@import "missing.css"; */\np { background: url("../assets/missing.png"); }';
    rejected(
      validFiles(markedText, css),
      cssFile,
      'asset-missing',
      '../assets/missing.png',
      'assets/missing.png',
    );
  });

  it('ignores commented CSS imports, URLs and font faces in stylesheets and template styles', () => {
    const comment =
      '/* @import "missing.css";\n p { background: url(https://cdn.example/ignored.png); }\n @font-face { font-family: Unused; src: url(missing.woff2); } */';
    accepted(validFiles(`<style>${comment}</style>${markedText}`, comment));
  });

  it('skips data, fragment and dynamic references in HTML, srcset and CSS while allowing ordinary anchor hrefs', () => {
    accepted(
      validFiles(
        `<section data-gt="paragraph"><img src="data:image/png;base64,AA=="><img src="#logo"><img src="{{holder}}"><img srcset="{{holder}} 1x, ../assets/logo.png 2x"><a href="https://example.com">{{holder}}</a><svg><use xlink:href="#logo"/></svg><p style="background: url('{{holder}}')">{{holder}}</p></section><style>p { background: url(#mask); }</style>`,
        'p { background: url(data:image/png;base64,AA==); mask: url(#mask); border-image: url("{{holder}}"); }',
      ),
    );
  });
});
