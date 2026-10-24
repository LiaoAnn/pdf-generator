import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { checkPack, type PackFiles } from './index.ts';

const templateFile = 'templates/report.hbs';
const cssFile = 'styles/base.css';
function pack(
  template = '<p data-gt="paragraph">{{holder}}</p>',
  css = '',
): PackFiles {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: 1,
      id: 'review-report',
      name: 'Review',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [cssFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: [
          'assets/logo.svg',
          'assets/font.woff2',
          'assets/nested/extra.css',
        ],
      },
    }),
    [templateFile]: template,
    [cssFile]: css,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: {
        holder: { type: 'name' },
        rows: {
          type: 'array',
          minItems: 10,
          maxItems: 10,
          items: { type: 'integer', min: 0, max: 10 },
        },
      },
    }),
    'sample.json': JSON.stringify({
      holder: '王小明',
      rows: Array(10).fill(1),
    }),
    'assets/logo.svg': '<svg/>',
    'assets/font.woff2': new Uint8Array([0xff]),
    'assets/nested/extra.css': '',
  };
}
function at(source: string, token: string) {
  const offset = source.indexOf(token);
  expect(offset).toBeGreaterThanOrEqual(0);
  const lines = source.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
function rejects(
  files: PackFiles,
  code: string,
  token?: string,
  file = templateFile,
) {
  const result = checkPack(files);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  const expected = {
    code,
    file,
    ...(token === undefined ? {} : at(String(files[file]), token)),
  };
  expect(
    result.issues.map(({ message, ...issue }) => {
      expect(message.trim()).not.toBe('');
      return issue;
    }),
  ).toEqual([expected]);
}
function accepts(files: PackFiles) {
  expect(checkPack(files)).toMatchObject({ ok: true, issues: [] });
}

describe('table cell checkbox metadata (T13 parity)', () => {
  it('accepts multiple printed checkbox states and labels in one cell', () => {
    accepts(
      pack(
        '<table data-gt="table"><tr><td><span data-gt-checked="true">☑</span> 是 <span data-gt-checked="false">☐</span> 否</td></tr></table>',
      ),
    );
  });
  it.each(['td', 'th'] as const)(
    'accepts a mustache checkbox state below nested elements in a %s',
    cell => {
      const files = pack(
        `<table data-gt="table"><tr><${cell}><div><span data-gt-checked="{{approved}}">☑</span> 同意</div></${cell}></tr></table>`,
      );
      files['rules.json'] = JSON.stringify({
        schemaVersion: 1,
        fields: { approved: { type: 'checkbox' } },
      });
      files['sample.json'] = JSON.stringify({ approved: true });
      accepts(files);
    },
  );
  it.each(['', 'TRUE', '1', 'yes'] as const)(
    'rejects invalid cell checkbox state %j at its attribute',
    value =>
      rejects(
        pack(
          `<table data-gt="table"><tr><td>\n <span data-gt-checked="${value}">☑</span></td></tr></table>`,
        ),
        'gt-attribute',
        'data-gt-checked',
      ),
  );
  describe.each(['', 'data-gt-checked="true" '] as const)(
    'cell descendant with attributes %j',
    checked => {
      it.each(['id', 'latex', 'text', 'custom'] as const)(
        'rejects data-gt-%s at that attribute',
        name => {
          rejects(
            pack(
              `<table data-gt="table"><tr><td>\n <span ${checked}data-gt-${name}="x">☑</span></td></tr></table>`,
            ),
            'gt-attribute',
            `data-gt-${name}`,
          );
        },
      );
    },
  );
  it('rejects a nested block even when it is a checkbox inside a cell', () => {
    rejects(
      pack(
        '<table data-gt="table"><tr><td>\n <span data-gt="checkbox" data-gt-checked="true">☑</span></td></tr></table>',
      ),
      'gt-nested',
      'data-gt="checkbox"',
    );
  });
  it.each([
    [
      'paragraph',
      '<p data-gt="paragraph">\n <span data-gt-checked="true">☑</span></p>',
    ],
    [
      'caption',
      '<table data-gt="table"><caption>\n <span data-gt-checked="true">☑</span></caption><tr><td>x</td></tr></table>',
    ],
    [
      'unmarked table',
      '<div data-gt="paragraph"><table><tr><td>\n <span data-gt-checked="true">☑</span></td></tr></table></div>',
    ],
  ] as const)('rejects orphan checkbox metadata in a %s', (_name, template) => {
    rejects(pack(template), 'gt-attribute', 'data-gt-checked');
  });
  describe.each(['td', 'th'] as const)('metadata on the %s itself', cell => {
    it.each(['checked', 'id', 'latex', 'text', 'custom'] as const)(
      'rejects data-gt-%s rather than treating the cell as a checkbox',
      name => {
        rejects(
          pack(
            `<table data-gt="table"><tr>\n <${cell} data-gt-${name}="true">☑</${cell}></tr></table>`,
          ),
          'gt-table',
          `data-gt-${name}`,
        );
      },
    );
  });
});

describe('page-number slots', () => {
  it('accepts the running page-number example without rejecting its runtime slots', () => {
    accepts(
      pack(
        '<div class="running-page-number" data-gt="page_number">第 <span data-gt-page-number></span> 頁，共 <span data-gt-page-count></span> 頁</div>',
      ),
    );
  });
  it('accepts empty-valued slots through unmarked wrappers inside a page-number block', () => {
    accepts(
      pack(
        '<div data-gt="page_number"><div><span data-gt-page-number=""></span> / <span data-gt-page-count=""></span></div></div>',
      ),
    );
  });

  describe.each(['data-gt-page-number', 'data-gt-page-count'])(
    '%s',
    attribute => {
      const slot = (content = '', value = '') =>
        `<span\n ${attribute}${value}>${content}</span>`;
      const pageNumber = (content: string) =>
        `<div data-gt="page_number">${content}</div>`;

      it.each([
        ['outside any mark', slot()],
        ['inside a footer mark', `<div data-gt="page_footer">${slot()}</div>`],
        [
          'on the page-number mark itself',
          `<div data-gt="page_number"\n ${attribute}></div>`,
        ],
        [
          'on another block type',
          `<div data-gt="page_footer"\n ${attribute}></div>`,
        ],
        [
          'on a marked descendant',
          pageNumber(`<span data-gt="paragraph"\n ${attribute}></span>`),
        ],
      ])('rejects a slot %s at the slot attribute', (_name, template) => {
        const result = checkPack(pack(template));
        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty('pack');
        expect(result.issues).toContainEqual({
          code: 'gt-attribute',
          file: templateFile,
          ...at(template, attribute),
          message: expect.stringMatching(/page_number/),
        });
      });

      it.each([
        ['literal text', '2'],
        ['whitespace', ' \n '],
        ['a field', '{{holder}}'],
        ['an empty child element', '<b></b>'],
        ['a comment node', '<!-- reserved -->'],
      ])(
        'rejects slot content containing %s before the runtime overwrites it',
        (_name, content) => {
          const template = pageNumber(slot(content));
          rejects(pack(template), 'gt-attribute', attribute);
          expect(checkPack(pack(template)).issues[0]?.message).toMatch(
            /empty|child|content/i,
          );
        },
      );

      it.each(['2', ' ', '{{holder}}'])(
        'rejects slot attribute value %j instead of treating it as runtime input',
        value => {
          const template = pageNumber(slot('', `="${value}"`));
          rejects(pack(template), 'gt-attribute', attribute);
          expect(checkPack(pack(template)).issues[0]?.message).toMatch(
            /empty|value/i,
          );
        },
      );
    },
  );
});

describe('review regressions: ground truth metadata', () => {
  it.each(['bad.id', '臺灣', 'x'.repeat(61), 'row.{{@index}}'])(
    'rejects id literal %s that cannot survive gt id suffixing',
    id => {
      rejects(
        pack(
          `{{#each rows}}<p data-gt="field"\n data-gt-id="${id}">{{this}}</p>{{/each}}`,
        ),
        'gt-id',
        'data-gt-id',
      );
    },
  );
  it('keeps 60-character ids, repeated ids and mustache-only ids uploadable', () => {
    accepts(
      pack(
        `{{#each rows}}<p data-gt="field" data-gt-id="${'x'.repeat(60)}">{{this}}</p><p data-gt="field" data-gt-id="row-{{@index}}">x</p><p data-gt="field" data-gt-id="{{@index}}">x</p>{{/each}}`,
      ),
    );
  });
  it.each([
    [
      'unknown metadata',
      '<p data-gt="paragraph" data-gt-custom="x">x</p>',
      'data-gt-custom',
    ],
    ...['id', 'checked', 'latex', 'text'].map(name => [
      `orphan ${name}`,
      `<div data-gt-${name}="${name === 'checked' ? 'true' : 'x'}"></div>`,
      `data-gt-${name}`,
    ]),
    [
      'checked on paragraph',
      '<p data-gt="paragraph" data-gt-checked="true">x</p>',
      'data-gt-checked',
    ],
    [
      'uppercase checked',
      '<p data-gt="checkbox" data-gt-checked="TRUE">x</p>',
      'data-gt-checked',
    ],
    [
      'empty checked',
      '<p data-gt="checkbox" data-gt-checked="">x</p>',
      'data-gt-checked',
    ],
    [
      'latex on paragraph',
      '<p data-gt="paragraph" data-gt-latex="x">x</p>',
      'data-gt-latex',
    ],
    [
      'empty latex',
      '<p data-gt="formula" data-gt-latex="">x</p>',
      'data-gt-latex',
    ],
    [
      'text on paragraph',
      '<p data-gt="paragraph" data-gt-text="x">x</p>',
      'data-gt-text',
    ],
  ])(
    'rejects %s rather than silently losing metadata',
    (_name, template, token) =>
      rejects(pack(template ?? ''), 'gt-attribute', token),
  );
  it.each([
    '',
    '<input type="text">',
    '<input type="checkbox"><input type="radio">',
  ])('rejects ambiguous checkbox controls %s', children => {
    rejects(
      pack(`<p data-gt="checkbox">${children}</p>`),
      'gt-checkbox',
      'data-gt',
    );
  });
  it('rejects formula markup without a TeX annotation', () =>
    rejects(
      pack(
        '<div data-gt="formula"><math><annotation encoding="text/plain">x</annotation></math></div>',
      ),
      'gt-formula',
      'data-gt',
    ));
  it('locates image text at its first nonblank source character', () =>
    rejects(
      pack(
        '<div data-gt="image" data-gt-text="logo">\n <span>  visible</span></div>',
      ),
      'gt-image-text',
      'visible',
    ));
  it('accepts explicit and inferred checkbox/formula metadata and blank image content', () => {
    accepts(
      pack(
        '<p data-gt="checkbox" data-gt-checked="false">x</p><p data-gt="checkbox" data-gt-checked="{{holder}}">x</p><p data-gt="checkbox"><input type="CHECKBOX"></p><p data-gt="checkbox"><input type="Radio"></p><div data-gt="formula" data-gt-latex="x">x</div><div data-gt="formula"><math><annotation encoding="application/x-tex">x</annotation></math></div><div data-gt="image" data-gt-text="logo"> <span> </span></div>',
      ),
    );
  });
  it('rejects a table block on a non-table element', () =>
    rejects(pack('<div data-gt="table">x</div>'), 'gt-table', 'data-gt'));
  it.each(['td', 'th'])('reserves %s metadata for table extraction', tag => {
    for (const attribute of [
      'data-gt="field"',
      'data-gt-id="cell"',
      'data-gt-checked="true"',
      'data-gt-latex="x"',
      'data-gt-text="x"',
      'data-gt-custom="x"',
    ]) {
      rejects(
        pack(
          `<table data-gt="table"><tr><${tag}\n ${attribute}>x</${tag}></tr></table>`,
        ),
        'gt-table',
        attribute,
      );
    }
  });
  it('still rejects a marked descendant inside a cell as nested', () =>
    rejects(
      pack(
        '<table data-gt="table"><tr><td><span data-gt="field">x</span></td></tr></table>',
      ),
      'gt-nested',
      'data-gt="field"',
    ));
  it('allows unmarked checkbox inputs in table cells', () =>
    accepts(
      pack(
        '<table data-gt="table"><tr><td><input type="checkbox"></td></tr></table>',
      ),
    ));
});

describe('review regressions: HTML and Handlebars branches', () => {
  it('distinguishes separate blocks at the same nesting depth', () => {
    rejects(
      pack(
        '{{#if holder}}<div data-gt="paragraph">{{/if}}{{#if rows}}</div>{{/if}}',
      ),
      'gt-branch',
      '<div',
    );
  });
  it('rejects an outer element closed inside a block', () => {
    rejects(
      pack('<div data-gt="paragraph">{{#if holder}}x</div>{{/if}}'),
      'gt-branch',
      '<div',
    );
  });

  it.each(['if', 'unless', 'with', 'each'])(
    'rejects tags crossing a %s branch boundary',
    helper => {
      rejects(
        pack(
          `{{#${helper} rows}}<div data-gt="paragraph">{{/${helper}}}x</div>`,
        ),
        'gt-branch',
        '<div',
      );
    },
  );
  it('rejects the else div closing outside its branch even when its opening is unmarked', () => {
    const template =
      '{{#if holder}}<div data-gt="paragraph">{{else}}<div>{{/if}}文字</div>';
    const result = checkPack(pack(template));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('pack');
    expect(
      result.issues.map(({ message, ...issue }) => {
        expect(message.trim()).not.toBe('');
        return issue;
      }),
    ).toEqual(
      ['<div data-gt', '<div>{{/if}}'].map(token => ({
        code: 'gt-branch',
        file: templateFile,
        ...at(template, token),
      })),
    );
  });
  it('rejects an implicit paragraph whose content escapes its branch', () => {
    const files = pack(
      '{{#if approved}}<p data-gt="paragraph">{{/if}}Unmarked<p data-gt="paragraph">Next</p>',
    );
    files['rules.json'] = JSON.stringify({
      schemaVersion: 1,
      fields: { approved: { type: 'constant', value: false } },
    });
    files['sample.json'] = JSON.stringify({ approved: false });
    rejects(files, 'gt-branch', '<p');
  });
  it('allows implicit paragraph content in its opening branch or a nested branch', () => {
    accepts(
      pack(
        '{{#if holder}}<p data-gt="paragraph">x {{#if rows}}y{{/if}}{{/if}}',
      ),
    );
  });
  it.each(['data-gt="paragraph"', 'data-gt-id="x"'])(
    'rejects conditionally attached %s',
    attribute => {
      const fixed = attribute.startsWith('data-gt-id')
        ? ' data-gt="paragraph"'
        : '';
      const template = `<p${fixed} {{#if holder}}${attribute}{{/if}}></p>`;
      const result = checkPack(pack(template));
      expect(result.ok).toBe(false);
      expect(
        result.issues.map(({ code, file, line, column }) => ({
          code,
          file,
          line,
          column,
        })),
      ).toEqual(
        ['{{#if holder}}', '{{/if}}'].map(token => ({
          code: 'template-structure',
          file: templateFile,
          ...at(template, token),
        })),
      );
    },
  );
  it('allows complete elements in separate branches, conditional classes and implicit end tags', () => {
    accepts(
      pack(
        '{{#if holder}}<p data-gt="paragraph" class="{{#if holder}}a{{else}}b{{/if}}">x</p>{{else}}<p data-gt="paragraph">y</p>{{/if}}<ul>{{#each rows}}<li data-gt="list_item">{{this}}{{/each}}</ul>',
      ),
    );
  });
});

describe('review regressions: active HTML and dynamic loads', () => {
  it.each([
    ['inline script', '<script>void 0</script>', '<script'],
    [
      'script in template content',
      '<template><script>void 0</script></template>',
      '<script',
    ],
    ['pack script', '<script src="../assets/logo.svg"></script>', '<script'],
    [
      'event handler',
      '<p data-gt="paragraph"\n OnClick="void 0">x</p>',
      'OnClick',
    ],
    ['nonstandard on prefix', '<p data-gt="paragraph" only="x">x</p>', 'only'],
    ['srcdoc', '<div srcdoc=""></div>', 'srcdoc'],
    ['base', '<base href="./">', '<base'],
    ['refresh', '<meta http-equiv="ReFrEsH" content="0">', '<meta'],
  ])('rejects %s before it can execute or redirect', (_name, template, token) =>
    rejects(pack(template), 'html-active', token),
  );
  it.each([
    ['src', '<img data-gt="image" src="{{holder}}">'],
    [
      'srcset',
      '<img data-gt="image" srcset="../assets/logo.svg 1x, {{holder}} 2x">',
    ],
    [
      'source',
      '<picture data-gt="image"><source srcset="{{holder}}"></picture>',
    ],
    ['link', '<link href="{{holder}}" rel="stylesheet">'],
    ['partial URL', '<img data-gt="image" src="../assets/{{holder}}.svg">'],
  ])(
    'rejects %s URLs that sample rendering cannot prove safe',
    (_name, template) =>
      rejects(
        pack(template),
        'asset-dynamic',
        template.includes('../assets/{{') ? '../assets/{{' : '{{holder}}',
      ),
  );
  it.each(['iframe', 'object', 'embed'])(
    'rejects a data document loaded through %s',
    tag => {
      const attr = tag === 'object' ? 'data' : 'src';
      rejects(
        pack(
          `<${tag} data-gt="image" ${attr}="data:text/html,hello"></${tag}>`,
        ),
        'html-unsupported',
        `<${tag}`,
      );
    },
  );
  it('allows data images and harmless meta elements', () =>
    accepts(
      pack(
        '<meta charset="utf-8"><picture data-gt="image"><source srcset="data:image/png;base64,AA== 1x"><img src="data:image/png;base64,AA=="></picture>',
        'p{background:url(data:image/png;base64,AA==)}',
      ),
    ));
});

describe('review regressions: CSS tokenization and reached stylesheets', () => {
  it.each(['p{background:u\\72l(missing.png)}', '@\\69mport "missing.css";'])(
    'rejects escaped loading identifiers %s',
    css => rejects(pack(undefined, css), 'css-escape', '\\', cssFile),
  );
  it.each([
    '<style>p{background:u\\72l(missing.png)}</style>',
    '<p data-gt="paragraph" style="background:u\\72l(missing.png)">x</p>',
  ])('checks CSS escapes in template context %s', template =>
    rejects(pack(template), 'css-escape', '\\'),
  );
  it('does not scan URL-like strings or literal Unicode content as CSS references', () =>
    accepts(
      pack(
        undefined,
        'p::before{content:"url(missing.png) •"} /* u\\72l(missing.png) */',
      ),
    ));
  it.each(['image-set', '-webkit-image-set'])(
    'checks string references inside %s',
    fn =>
      rejects(
        pack(
          undefined,
          `p{background:${fn}("../assets/logo.svg" 1x, "missing.png" 2x)}`,
        ),
        'asset-missing',
        'missing.png',
        cssFile,
      ),
  );
  it.each(['link', 'import'])(
    'follows %s stylesheets listed as assets and resolves against their directory',
    via => {
      const files = pack(
        via === 'link'
          ? '<link rel="stylesheet" href="../assets/nested/extra.css">'
          : undefined,
        via === 'import' ? '@import "../assets/nested/extra.css";' : '',
      );
      files['assets/nested/extra.css'] =
        'p{background:url(../logo.svg)}\np{background:url(missing.svg)}';
      rejects(files, 'asset-missing', 'missing.svg', 'assets/nested/extra.css');
    },
  );
  it('checks a reached font face instead of ignoring asset CSS declarations', () => {
    const files = pack(
      '<link rel="stylesheet" href="../assets/nested/extra.css">',
    );
    files['assets/nested/extra.css'] =
      '@font-face{font-family:Unused;src:url(../font.woff2)}';
    rejects(files, 'font-unused', '@font-face', 'assets/nested/extra.css');
  });
  it('counts font usage in reached CSS and terminates import cycles without duplicate diagnostics', () => {
    const files = pack(
      '<link rel="stylesheet" href="../assets/nested/extra.css">',
      '@import "../assets/nested/extra.css";\n@font-face{font-family:Report;src:url(../assets/font.woff2)}',
    );
    files['assets/nested/extra.css'] =
      '@import "../../styles/base.css";p{font-family:Report}';
    accepts(files);
    files['assets/nested/extra.css'] += '\np{background:url(missing.svg)}';
    rejects(files, 'asset-missing', 'missing.svg', 'assets/nested/extra.css');
  });
  it('rejects non-UTF8 reached CSS instead of silently treating it as an opaque asset', () => {
    const files = pack(
      '<link rel="stylesheet" href="../assets/nested/extra.css">',
    );
    files['assets/nested/extra.css'] = new Uint8Array([0xff, 0xfe]);
    rejects(files, 'text-encoding', undefined, 'assets/nested/extra.css');
  });
  it('counts SVG font-family presentation attributes as usage', () =>
    accepts(
      pack(
        '<svg data-gt="image"><text font-family="Report">x</text></svg>',
        '@font-face{font-family:Report;src:url(../assets/font.woff2)}',
      ),
    ));
  it('counts custom property values as font usage via var()', () =>
    accepts(
      pack(
        undefined,
        '@font-face{font-family:Report;src:url(../assets/font.woff2)} :root{--body-font:Report}p{font-family:var(--body-font)}',
      ),
    ));
});

describe('review regressions: untrusted resource limits and prototype names', () => {
  it('counts extracted bytes even when a stored zip lies about central-directory sizes', () => {
    const files = Object.fromEntries(
      Object.entries(pack()).map(([name, value]) => [
        name,
        typeof value === 'string' ? strToU8(value) : value,
      ]),
    );
    const zip = zipSync(files, { level: 0 });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i <= zip.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50)
        view.setUint32(i + 24, 1, true);
    }
    expect(
      Object.values(unzipSync(zip)).reduce(
        (sum, bytes) => sum + bytes.length,
        0,
      ),
    ).toBeGreaterThan(100);
    const result = checkPack(zip, { maxBytes: 100 });
    expect(result.ok).toBe(false);
    expect(
      result.issues.map(({ message, ...issue }) => {
        expect(message).not.toBe('');
        return issue;
      }),
    ).toEqual([{ code: 'pack-too-large', file: '.' }]);
  });
  it('turns stack-overflowing rules into one located rules-invalid issue', () => {
    const files = pack();
    files['rules.json'] =
      '{"schemaVersion":1,"fields":{"deep":' +
      '{"type":"object","fields":{"child":'.repeat(2000) +
      '{"type":"name"}' +
      '}}'.repeat(2000) +
      '}}';
    let result: ReturnType<typeof checkPack> | undefined;
    expect(() => {
      result = checkPack(files);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false });
    expect(
      result?.issues.map(({ message, ...issue }) => {
        expect(message).not.toBe('');
        return issue;
      }),
    ).toEqual([
      {
        code: 'rules-invalid',
        file: 'rules.json',
        line: 1,
        column: 1,
        path: [],
      },
    ]);
  });
  it('rejects constructor as unsupported without a prototype-name crash or unmarked cascade', () => {
    rejects(
      pack('<constructor></constructor>'),
      'html-unsupported',
      '<constructor',
    );
    rejects(
      pack('<constructor>visible</constructor>'),
      'html-unsupported',
      '<constructor',
    );
  });
});
