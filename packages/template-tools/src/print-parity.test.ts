import { describe, expect, it } from 'vitest';
import { checkPack, type PackFiles } from './index.ts';

const templateFile = 'report.hbs';
const cssFile = 'report.css';
function pack(
  template = '<p data-gt="paragraph">{{value}}</p>',
  css = '',
): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'print-parity',
      name: 'Print parity',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [cssFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: ['logo.svg', 'nested/notes.txt', 'nested/extra.css'],
      },
    }),
    [templateFile]: template,
    [cssFile]: css,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
    'logo.svg': '<svg/>',
    'nested/notes.txt': '',
    'nested/extra.css': '',
  };
}

// Check each rule independently: a crossing RCDATA element can also contain
// forbidden statements, and those are separate diagnostics at separate places.
function rejects(
  files: PackFiles,
  code: string,
  tokens: string[],
  file = templateFile,
) {
  const source = String(files[file]);
  const result = checkPack(files);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  expect(
    result.issues
      .filter(issue => issue.code === code)
      .map(({ message, ...issue }) => {
        expect(message.trim()).not.toBe('');
        return issue;
      }),
  ).toEqual(
    tokens.map(token => {
      const offset = source.indexOf(token);
      expect(offset).toBeGreaterThanOrEqual(0);
      const lines = source.slice(0, offset).split('\n');
      return {
        code,
        file,
        line: lines.length,
        column: (lines.at(-1)?.length ?? 0) + 1,
      };
    }),
  );
  return result;
}
function accepts(files: PackFiles) {
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });
}

describe('print parity: parser-dependent HTML', () => {
  it.each(['select', 'option', 'optgroup', 'noscript'])(
    'rejects %s at its element rather than relying on parse5 content parsing',
    tag => {
      rejects(
        pack(`\n  <${tag} data-gt="paragraph"></${tag}>`),
        'html-unsupported',
        [`<${tag}`],
      );
    },
  );
  it.each(['img', 'link', 'div'])(
    'rejects the select bypass with a Chrome-retained %s child',
    tag => {
      const child =
        tag === 'img'
          ? '<img src="https://x/d.png">'
          : tag === 'link'
            ? '<link rel="stylesheet" href="https://x/l.css">'
            : '<div>outside</div>';
      rejects(pack(`<select>${child}</select>`), 'html-unsupported', [
        '<select',
      ]);
    },
  );
  it('rejects noscript in head before scripting mode can change its link parsing', () => {
    rejects(
      pack(
        '<html><head>\n<noscript><link rel="stylesheet" href="https://x/l.css"></noscript></head><body></body></html>',
      ),
      'html-unsupported',
      ['<noscript'],
    );
  });
});

describe('print parity: branch boundaries apply to every element', () => {
  it('rejects the reviewed title/link branch crossing in head', () => {
    rejects(
      pack(
        '<html><head>{{#if value}}<title>{{/if}}<link rel="stylesheet" href="x.css">{{#if value}}</title>{{/if}}</head><body></body></html>',
      ),
      'gt-branch',
      ['<title'],
    );
  });
  it.each(['head', 'style', 'title'])(
    'rejects an exempt %s element opened and closed in separate blocks',
    tag => {
      const content = tag === 'head' ? '<title>Report</title>' : 'text';
      rejects(
        pack(
          `<html>{{#if value}}<${tag}>{{/if}}${content}{{#if value}}</${tag}>{{/if}}<body></body></html>`,
        ),
        'gt-branch',
        [`<${tag}`],
      );
    },
  );
  it('rejects a textarea opened and closed in separate blocks', () => {
    rejects(
      pack(
        '{{#if value}}<textarea data-gt="field">{{/if}}text{{#if value}}</textarea>{{/if}}',
      ),
      'gt-branch',
      ['<textarea'],
    );
  });
  it('checks branch boundaries inside inert template content too', () => {
    rejects(
      pack('<template>{{#if value}}<div>{{/if}}text</div></template>'),
      'gt-branch',
      ['<div'],
    );
  });
  it.each(['title', 'style', 'textarea'])(
    'checks last content when a %s has no end tag',
    tag => {
      rejects(
        pack(
          `{{#if value}}<${tag}${tag === 'textarea' ? ' data-gt="field"' : ''}>{{/if}}escaped content`,
        ),
        'gt-branch',
        [`<${tag}`],
      );
    },
  );
  it.each(['title', 'textarea'])(
    'forbids block open/else/close and comments in %s content',
    tag => {
      rejects(
        pack(
          `<${tag}${tag === 'textarea' ? ' data-gt="field"' : ''}>\n{{#if value}}yes{{else}}no{{/if}}{{! comment}}</${tag}>`,
        ),
        'template-structure',
        ['{{#if value}}', '{{else}}', '{{/if}}', '{{! comment}}'],
      );
    },
  );
  it('positive control: accepts a mustache in title text', () => {
    accepts(
      pack('<html><head><title>{{value}}</title></head><body></body></html>'),
    );
  });
  it('positive control: accepts a textarea with a mustache', () => {
    accepts(pack('<textarea data-gt="field">{{value}}</textarea>'));
  });
  it('positive control: accepts complete head elements in one branch', () => {
    accepts(
      pack(
        '<html><head>{{#if value}}<title>Report</title><style>p{color:red}</style>{{else}}<title>Empty</title>{{/if}}</head><body></body></html>',
      ),
    );
  });
});

describe('print parity: statements cannot splice resource URLs or foreign attributes', () => {
  it.each([
    [
      'src',
      '<img data-gt="image" src="{{#if value}}data:{{/if}}https://x/d.png">',
      ['{{#if value}}', '{{/if}}'],
    ],
    [
      'href',
      '<link rel="stylesheet" href="{{#if value}}#{{/if}}https://x/l.css">',
      ['{{#if value}}', '{{/if}}'],
    ],
    [
      'srcset',
      '<img data-gt="image" srcset="{{#if value}}logo.svg 1x{{else}}logo.svg 2x{{/if}}">',
      ['{{#if value}}', '{{else}}', '{{/if}}'],
    ],
    [
      'URL comment',
      '<a data-gt="paragraph" href="#{{! hidden}}x">link</a>',
      ['{{! hidden}}'],
    ],
    [
      'xlink:href',
      '<svg data-gt="image"><image xlink:href="{{#if value}}data:{{/if}}https://x/d.png"/></svg>',
      ['{{#if value}}', '{{/if}}'],
    ],
  ] as const)(
    'rejects structural statements in %s at each statement',
    (_name, template, tokens) => {
      const result = rejects(pack(template), 'template-structure', [...tokens]);
      expect(
        result.issues.filter(issue => issue.code === 'asset-dynamic'),
      ).toEqual([]);
    },
  );
  it.each([
    [
      '<img data-gt="image" src="prefix-{{value}}.svg">',
      'prefix-{{value}}.svg',
    ],
    ['<img data-gt="image" srcset="logo.svg {{value}}">', '{{value}}'],
    ['<img data-gt="image" srcset="logo.svg 1x, {{value}} 2x">', '{{value}}'],
    [
      '<picture data-gt="image"><source srcset="logo.svg {{value}}"></picture>',
      '{{value}}',
    ],
    ['<a data-gt="paragraph" href="#{{value}}">link</a>', '#{{value}}'],
  ])('rejects a dynamic URL or srcset descriptor: %s', (template, token) => {
    rejects(pack(template), 'asset-dynamic', [token]);
  });
  it.each([
    '<svg data-gt="image"><rect fill="{{value}}"/></svg>',
    '<svg data-gt="image"><rect fill="{{#if value}}red{{else}}blue{{/if}}"/></svg>',
    '<svg data-gt="image"><rect data-label="{{! hidden}}"/></svg>',
    '<svg data-gt="image"><image href="{{value}}"/></svg>',
    '<svg data-gt="image"><use href="{{value}}"/></svg>',
    '<math data-gt="field"><mi mathcolor="{{value}}">x</mi></math>',
    '<math data-gt="field"><mi data-label="{{#if value}}x{{else}}y{{/if}}{{! hidden}}">x</mi></math>',
  ])('rejects every statement in a foreign attribute: %s', template => {
    const tokens = [...template.matchAll(/\{\{.*?\}\}/g)].map(
      match => match[0],
    );
    const result = rejects(pack(template), 'template-structure', tokens);
    expect(
      result.issues.filter(issue => issue.code === 'asset-dynamic'),
    ).toEqual([]);
  });
});

describe('print parity: SVG presentation attributes load CSS URLs', () => {
  for (const attribute of [
    'fill',
    'mask',
    'clip-path',
    'marker-end',
    'cursor',
    'data-paint',
  ]) {
    it.each([
      ['https://x/g.svg#g', 'asset-external'],
      ['../g.svg#g', 'asset-path'],
      ['missing.svg#g', 'asset-missing'],
    ])(`checks ${attribute} url(%s) at the URL`, (url, code) => {
      rejects(
        pack(`<svg data-gt="image"><rect\n ${attribute}="url(${url})"/></svg>`),
        code,
        [url],
      );
    });
  }
  it('positive control: accepts fragment URLs in SVG fill', () => {
    accepts(
      pack(
        '<svg data-gt="image"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>',
      ),
    );
  });
  it('positive control: accepts a pack-local SVG presentation reference', () => {
    accepts(pack('<svg data-gt="image"><rect fill="url(logo.svg#g)"/></svg>'));
  });
});

describe('print parity: image-set cannot obtain URLs dynamically', () => {
  for (const imageSet of ['image-set', '-webkit-image-set']) {
    for (const dynamic of ['var(--image)', 'env(image)', 'attr(data-image)']) {
      it.each(['file', 'style element', 'style attribute', 'SVG attribute'])(
        `rejects ${dynamic} inside ${imageSet} in %s`,
        context => {
          const declaration = `background:${imageSet}(${dynamic} 1x)`;
          const files =
            context === 'file'
              ? pack(undefined, `p{${declaration}}`)
              : pack(
                  context === 'style element'
                    ? `<style>p{${declaration}}</style>`
                    : context === 'style attribute'
                      ? `<p data-gt="paragraph" style="${declaration}">x</p>`
                      : `<svg data-gt="image"><rect fill="${imageSet}(${dynamic} 1x)"/></svg>`,
                );
          rejects(
            files,
            'asset-dynamic',
            [dynamic],
            context === 'file' ? cssFile : templateFile,
          );
        },
      );
    }
  }
  it('detects dynamic functions nested below another function inside image-set', () => {
    rejects(
      pack(
        undefined,
        'p{background:image-set(cross-fade(var(--image),url(logo.svg),50%) 1x)}',
      ),
      'asset-dynamic',
      ['cross-fade(', 'var(--image)'],
      cssFile,
    );
  });
  it('positive control: accepts var() outside image-set in all CSS contexts', () => {
    accepts(
      pack(
        '<style>p{color:var(--ink)}</style><p data-gt="paragraph" style="color:var(--ink)">x</p><svg data-gt="image"><rect fill="var(--paint)"/></svg>',
        ':root{--ink:black}p{color:var(--ink);padding:env(safe-area-inset-top)}p::before{content:attr(data-label)}',
      ),
    );
  });
});

describe('print parity: stylesheet loading follows role rather than extension', () => {
  it.each(['link', 'import string', 'import url'])(
    'scans notes.txt reached by %s as CSS',
    via => {
      const files = pack(
        via === 'link'
          ? '<link rel="stylesheet" href="nested/notes.txt">'
          : undefined,
        via === 'import string'
          ? '@import "nested/notes.txt";'
          : via === 'import url'
            ? '@import url("nested/notes.txt");'
            : '',
      );
      files['nested/notes.txt'] =
        'p{background:url(../logo.svg)}\np{background:url(https://x/g.svg)}';
      rejects(files, 'asset-external', ['https://x/g.svg'], 'nested/notes.txt');
    },
  );
  it('follows transitive imports and resolves non-CSS stylesheet paths relative to their file', () => {
    const files = pack('<link rel="stylesheet" href="nested/extra.css">');
    files['nested/extra.css'] = '@import "notes.txt";';
    files['nested/notes.txt'] =
      'p{background:url(../logo.svg)}\np{background:url(missing.svg)}';
    rejects(files, 'asset-missing', ['missing.svg'], 'nested/notes.txt');
  });
  it.each(['link', 'import'])(
    'positive control: still follows a .css stylesheet via %s',
    via => {
      const files = pack(
        via === 'link'
          ? '<link rel="stylesheet" href="nested/extra.css">'
          : undefined,
        via === 'import' ? '@import "nested/extra.css";' : '',
      );
      files['nested/extra.css'] = 'p{background:url(missing.svg)}';
      rejects(files, 'asset-missing', ['missing.svg'], 'nested/extra.css');
    },
  );
});

describe('print parity: correctness review controls', () => {
  it('treats a whitespace-control long comment as one statement despite embedded braces and less-than', () => {
    accepts(
      pack('{{~!-- a }} <{{b}} --}}<p data-gt="paragraph">{{value}}</p>'),
    );
  });
  it.each(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img'])(
    'allows legacy print alignment on %s',
    tag => {
      accepts(
        pack(
          tag === 'img'
            ? '<img data-gt="image" align="left" src="logo.svg">'
            : `<${tag} data-gt="paragraph" align="center">x</${tag}>`,
        ),
      );
    },
  );
});

it('checks 20,000 marked mustache paragraphs in under three seconds', () => {
  checkPack(pack()); // Warm parsers; measure only the public check, not setup.
  const files = pack('<p data-gt="paragraph">{{value}}</p>'.repeat(20_000));
  const start = performance.now();
  const result = checkPack(files);
  const elapsed = performance.now() - start;
  expect(result).toMatchObject({ ok: true, issues: [] });
  expect(elapsed).toBeLessThan(3_000);
}, 30_000);

describe('print parity: round 4 SVG attribute CSS scanning', () => {
  it.each(['URL', 'Url'])(
    'checks %s(https://outside.invalid/leak.svg#x) in SVG fill',
    fn => {
      rejects(
        pack(
          `<svg data-gt="image"><rect fill="${fn}(https://outside.invalid/leak.svg#x)"/></svg>`,
        ),
        'asset-external',
        ['https://outside.invalid/leak.svg#x'],
      );
    },
  );
  it.each(['fill', 'data-paint'])(
    'rejects the reviewed escaped u\\72l in SVG %s at the backslash',
    attribute => {
      rejects(
        pack(
          `<svg data-gt="image"><rect ${attribute}="u\\72l(https://outside.invalid/leak.svg#x)"/></svg>`,
        ),
        'css-escape',
        ['\\72l'],
      );
    },
  );
  it('rejects an SVG attribute escape with no URL-like text', () => {
    rejects(
      pack('<svg data-gt="image"><rect fill="r\\65 d"/></svg>'),
      'css-escape',
      ['\\65'],
    );
  });
  it.each([
    '<svg data-gt="image"><rect fill="url(#g)"/></svg>',
    '<svg data-gt="image"><rect fill="red"/></svg>',
    '<svg data-gt="image"><path d="M0 0L10 10"/></svg>',
    '<svg data-gt="image" viewBox="0 0 10 10"></svg>',
    '<svg data-gt="image"><text font-family="Report">x</text></svg>',
  ])('round 4 positive control: accepts ordinary SVG values: %s', template => {
    accepts(
      pack(
        template,
        template.includes('font-family')
          ? '@font-face{font-family:Report;src:url(logo.svg)}'
          : '',
      ),
    );
  });
});

describe('print parity: round 4 CSS bad-string newlines', () => {
  for (const [name, newline] of [
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['form feed', '\f'],
    ['LF', '\n'],
  ]) {
    it.each(['file', 'style element', 'style attribute', 'SVG attribute'])(
      `finds the URL after an unterminated string ended by ${name} in %s`,
      context => {
        // These are literal CSS newlines at runtime, not backslash escapes.
        // Keep the reviewed stylesheet trigger verbatim in file/style cases.
        const declaration = `--x:"${newline};background-image:url(https://outside.invalid/leak);`;
        const stylesheet = `p{${declaration}}`;
        const files =
          context === 'file'
            ? pack(undefined, stylesheet)
            : pack(
                context === 'style element'
                  ? `<style>${stylesheet}</style>`
                  : context === 'style attribute'
                    ? `<p data-gt="paragraph" style='${declaration}'>x</p>`
                    : `<svg data-gt="image"><rect fill='${declaration}'/></svg>`,
              );
        rejects(
          files,
          'asset-external',
          ['https://outside.invalid/leak'],
          context === 'file' ? cssFile : templateFile,
        );
      },
    );
  }
});

it('checks 8,000 complete if branches in under three seconds', () => {
  checkPack(pack('{{#if value}}<p data-gt="paragraph">x</p>{{/if}}'));
  const files = pack(
    '{{#if value}}<p data-gt="paragraph">x</p>{{/if}}'.repeat(8_000),
  );
  const start = performance.now();
  const result = checkPack(files);
  const elapsed = performance.now() - start;
  expect(result).toMatchObject({ ok: true, issues: [] });
  expect(elapsed).toBeLessThan(3_000);
}, 30_000);

describe('print parity: round 5 forbids CSS escapes outside comments', () => {
  const contexts = [
    'file',
    'style element',
    'style attribute',
    'SVG attribute',
  ];
  function cssPack(context: string, declaration: string) {
    return context === 'file'
      ? pack(undefined, `p{${declaration}}`)
      : pack(
          context === 'style element'
            ? `<style>p{${declaration}}</style>`
            : context === 'style attribute'
              ? `<p data-gt="paragraph" style='${declaration}'>x</p>`
              : `<svg data-gt="image"><rect fill='${declaration}'/></svg>`,
        );
  }

  for (const [name, declaration] of [
    ['quoted hex escape', 'content:"\\2022"'],
    ['escaped quote', 'content:"a\\"b"'],
    ['escaped backslash', 'content:"\\\\tail"'],
    ['comment-like string', 'content:"/* \\2022 */"'],
    ['unquoted URL', 'background:url(data:image/png,\\41)'],
    ['quoted URL', 'background:url("data:image/png,\\41")'],
    ['ordinary token', '--x:r\\65 d'],
    ['trailing backslash', '--x:abc\\'],
  ] as const) {
    it.each(contexts)(`rejects every backslash in ${name} in %s`, context => {
      // Unique suffixes distinguish adjacent backslashes, so neither may be
      // skipped as the second character of an escape.
      const tokens = [...declaration.matchAll(/\\/g)].map(match =>
        declaration.slice(match.index),
      );
      rejects(
        cssPack(context, declaration),
        'css-escape',
        tokens,
        context === 'file' ? cssFile : templateFile,
      );
    });
  }

  for (const [name, declaration] of [
    [
      'escaped CRLF string',
      '--x:"\\\r\n";background-image:url(https://outside.invalid/leak);',
    ],
    [
      'escaped unquoted URL closing parenthesis',
      '--x:url(data:\\)");background-image:url(https://outside.invalid/leak);',
    ],
  ] as const) {
    it.each(contexts)(`rejects the reviewed ${name} in %s`, context => {
      // Do not require asset-external: rejecting the escape itself is the
      // policy, independent of recovery from these malformed CSS tokens.
      rejects(
        cssPack(context, declaration),
        'css-escape',
        ['\\'],
        context === 'file' ? cssFile : templateFile,
      );
    });
  }

  it('rejects the reviewed escaped CRLF represented by HTML character references', () => {
    rejects(
      pack(
        '<p data-gt="paragraph" style=\'--x:"\\&#13;&#10;";background-image:url(https://outside.invalid/leak);\'>x</p>',
      ),
      'css-escape',
      ['\\'],
    );
  });

  it.each(['style attribute', 'SVG attribute'])(
    'reports an entity-encoded backslash at its source position in %s',
    context => {
      rejects(cssPack(context, '\n  --x:"&#92;2022"'), 'css-escape', ['&#92;']);
    },
  );

  it.each(contexts)(
    'round 5 positive control: accepts literal Unicode content in %s',
    context => accepts(cssPack(context, 'content:"•"')),
  );
  it.each(contexts)(
    'round 5 positive control: ignores backslashes and URLs inside comments in %s',
    context =>
      accepts(
        cssPack(
          context,
          '/* \\2022 \\\\ url(https://outside.invalid/leak) */ color:red',
        ),
      ),
  );
});

it('checks 40,000 nested var() functions in under 1.5 seconds', () => {
  checkPack(pack(undefined, 'p{--x:var(--ink)}'));
  const files = pack(
    undefined,
    `p{--x:${'var('.repeat(40_000)}0${')'.repeat(40_000)}}`,
  );
  const start = performance.now();
  const result = checkPack(files);
  const elapsed = performance.now() - start;
  expect(result).toMatchObject({ ok: true, issues: [] });
  expect(elapsed).toBeLessThan(1_500);
}, 30_000);

describe('print parity: round 6 image-set direct function allowlist', () => {
  const contexts = [
    'file',
    'style element',
    'style attribute',
    'SVG attribute',
  ];
  function imagePack(context: string, value: string, prelude = '') {
    const declaration = `background-image:${value}`;
    return context === 'file'
      ? pack(undefined, `${prelude}\np{${declaration}}`)
      : pack(
          context === 'style element'
            ? `<style>${prelude}\np{${declaration}}</style>`
            : context === 'style attribute'
              ? `<style>${prelude}</style><p data-gt="paragraph"\n style='${declaration}'>x</p>`
              : `<style>${prelude}</style><svg data-gt="image"><rect\n fill='${value}'/></svg>`,
        );
  }

  for (const imageSet of ['image-set', '-webkit-image-set']) {
    for (const [name, argument, prelude] of [
      [
        'custom function',
        '--image() 1x',
        '@function --image() { result: "https://outside.invalid/leak"; }',
      ],
      [
        'if',
        'if(media(all): "https://outside.invalid/leak"; else: "https://outside.invalid/leak") 1x',
        '',
      ],
      ['var', 'var(--image) 1x', ''],
      ['env', 'env(image) 1x', ''],
      ['attr', 'attr(data-image) 1x', ''],
      ['unknown function', 'future-image() 1x', ''],
    ] as const) {
      it.each(contexts)(
        `round 6 rejects direct ${name} in ${imageSet} in %s at its name`,
        context => {
          const token = argument.slice(0, argument.indexOf('(') + 1);
          const files = imagePack(context, `${imageSet}(${argument})`, prelude);
          // The custom definition has the same name: distinguish the call by
          // using its complete suffix, while retaining the name's offset.
          rejects(
            files,
            'asset-dynamic',
            [name === 'custom function' ? '--image() 1x' : token],
            context === 'file' ? cssFile : templateFile,
          );
        },
      );
    }

    for (const argument of [
      'url(a.png) 1x, "b.png" 2x',
      '"a.png" type("image/png")',
      ...[
        'linear-gradient',
        'radial-gradient',
        'conic-gradient',
        'repeating-linear-gradient',
        'repeating-radial-gradient',
        'repeating-conic-gradient',
      ].flatMap(gradient =>
        ['', '-webkit-'].map(
          prefix => `${prefix}${gradient}(rgb(0 0 0), red) 1x`,
        ),
      ),
    ]) {
      it.each(contexts)(
        `round 6 positive control: accepts ${imageSet}(${argument}) in %s`,
        context => {
          const files = imagePack(context, `${imageSet}(${argument})`);
          const manifest = JSON.parse(String(files['manifest.json']));
          manifest.files.assets.push('a.png', 'b.png');
          files['manifest.json'] = JSON.stringify(manifest);
          files['a.png'] = new Uint8Array([1]);
          files['b.png'] = new Uint8Array([2]);
          accepts(files);
        },
      );
    }
  }
});

it('round 6 checks 160,000 unquoted data URLs in under 1.5 seconds', () => {
  checkPack(pack(undefined, 'p{background-image:url(data:,x)}'));
  const files = pack(
    undefined,
    `p{background-image:${'url(data:,x),'.repeat(159_999)}url(data:,x)}`,
  );
  const start = performance.now();
  const result = checkPack(files);
  const elapsed = performance.now() - start;
  expect(result).toMatchObject({ ok: true, issues: [] });
  expect(elapsed).toBeLessThan(1_500);
}, 30_000);

it('round 6 reports sample text conversion failure at the mustache without throwing', () => {
  const files = pack('<p data-gt="paragraph">\n  {{value}}</p>');
  files['rules.json'] = JSON.stringify({
    schemaVersion: 1,
    fields: {
      value: {
        type: 'object',
        fields: { toString: { type: 'constant', value: 'x' } },
      },
    },
  });
  files['sample.json'] = JSON.stringify({ value: { toString: 'x' } });
  rejects(files, 'template-render', ['{{value}}']);
});
