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
      id: 'allowlist-report',
      name: 'Allowlist regression',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [cssFile],
        rules: 'rules.json',
        sample: 'sample.json',
        assets: ['logo.svg', 'local.html'],
      },
    }),
    [templateFile]: template,
    [cssFile]: css,
    'rules.json': JSON.stringify({
      schemaVersion: 1,
      fields: { value: { type: 'constant', value: 'hello' } },
    }),
    'sample.json': JSON.stringify({ value: 'hello' }),
    'logo.svg':
      '<svg xmlns="http://www.w3.org/2000/svg"><script>void 0</script></svg>',
    'local.html': '<script>void 0</script>',
  };
}

function at(source: string, offset: number) {
  const lines = source.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

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
    result.issues.map(({ message, ...issue }) => {
      expect(message.trim()).not.toBe('');
      return issue;
    }),
  ).toEqual(
    tokens.map(token => {
      const offset = source.indexOf(token);
      expect(offset).toBeGreaterThanOrEqual(0);
      return { code, file, ...at(source, offset) };
    }),
  );
}

function accepts(template: string, css = '') {
  const result = checkPack(pack(template, css));
  expect(result).toMatchObject({ ok: true, issues: [] });
  expect(result.pack?.template).toBe(template);
}

describe('printed-document element and attribute allowlist', () => {
  it.each([
    'iframe',
    'object',
    'embed',
    'video',
    'audio',
    'canvas',
    'custom-widget',
  ])(
    'refuses %s once and suppresses unmarked, nested, active and asset diagnostics in its subtree',
    tag => {
      const body =
        '<div data-gt="paragraph"><span data-gt="field">nested</span></div><img src="https://outside.example/x"><script>void 0</script>unmarked';
      rejects(
        pack(`\n  <${tag}>${tag === 'embed' ? '' : body}</${tag}>`),
        'html-unsupported',
        [`<${tag}`],
      );
    },
  );

  it.each([
    ['object', 'data', 'logo.svg'],
    ['iframe', 'src', 'local.html'],
    ['embed', 'src', 'logo.svg'],
  ])(
    'blocks executable pack-local documents through %s even when the file exists',
    (tag, attr, url) => {
      rejects(
        pack(`<${tag} data-gt="image" ${attr}="${url}"></${tag}>`),
        'html-unsupported',
        [`<${tag}`],
      );
    },
  );

  it.each([
    ['input src', '<input data-gt="field"\n src="logo.svg">', 'src'],
    [
      'source src',
      '<picture data-gt="image"><source src="logo.svg"></picture>',
      'src',
    ],
    [
      'unlisted attribute',
      '<p data-gt="paragraph"\n frobnicate="x">text</p>',
      'frobnicate',
    ],
    [
      'attribute on wrong element',
      '<div data-gt="paragraph" href="#x">text</div>',
      'href',
    ],
    [
      'non-refresh http-equiv',
      '<meta http-equiv="content-security-policy" content="x">',
      'http-equiv',
    ],
    ['link preload', '<link rel="preload" href="logo.svg">', 'rel'],
    [
      'link multi-token rel',
      '<link rel="stylesheet preload" href="logo.svg">',
      'rel',
    ],
    ['link rel missing', '<link href="logo.svg">', '<link'],
    ['input image type', '<input data-gt="field" type="image">', 'type'],
    ['input submit type', '<input data-gt="field" type="submit">', 'type'],
  ])(
    'rejects %s at the offending attribute or element',
    (_name, template, token) => {
      rejects(pack(template), 'html-unsupported', [token]);
    },
  );

  it.each([
    [
      'script',
      '<script src="https://outside.example/x">void 0</script>',
      '<script',
    ],
    ['base', '<base href="https://outside.example/">', '<base'],
    ['refresh', '<meta http-equiv="refresh" content="0">', '<meta'],
    ['event handler', '<p data-gt="paragraph" OnClick="x">text</p>', 'OnClick'],
    ['srcdoc', '<div srcdoc=""></div>', 'srcdoc'],
    ['SVG event handler', '<svg data-gt="image" onload="x"></svg>', 'onload'],
    [
      'MathML event handler',
      '<math data-gt="field" onclick="x"><mi>x</mi></math>',
      'onclick',
    ],
  ])('keeps %s classified only as html-active', (_name, template, token) => {
    rejects(pack(template), 'html-active', [token]);
  });

  it('accepts representative print markup, global attributes, forms and quoted attribute templating', () => {
    accepts(
      '<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><title>Report</title><link rel="stylesheet" href="report.css"><style media="print">p{color:black}</style></head><body><main class="report" id="r" lang="zh-TW" dir="ltr" title="title" hidden translate="no" role="document" aria-label="report" data-custom="x"><section data-gt="paragraph"><h1>Title</h1><p class="{{#if value}}yes{{else}}no{{/if}}" title=\'{{value}}\'><strong>text</strong><br><time datetime="2026-01-01">date</time><a href="#r">link</a></p><ol start="2" reversed><li value="3">item</li></ol><label for="choice">Choice</label><textarea name="note" rows="2" cols="20" readonly disabled>{{value}}</textarea><input type="text" value="{{value}}" readonly><input type="checkbox" checked><input type="radio" disabled><input></section><table data-gt="table" border="1" cellpadding="2" cellspacing="0" width="100%" align="left" summary="summary"><caption>Table</caption><colgroup span="1"><col width="50"></colgroup><thead><tr><th scope="col" abbr="A">A</th></tr></thead><tbody><tr align="left" valign="top" height="20"><td colspan="1" rowspan="1" headers="a" nowrap>cell</td></tr></tbody></table></main></body></html>',
    );
  });

  it('accepts a KaTeX-like MathML formula with TeX annotation', () => {
    accepts(
      '<math data-gt="formula" display="block"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mfrac><mn>1</mn><msqrt><mi>y</mi></msqrt></mfrac></mrow><annotation encoding="application/x-tex">x^2+1/\\sqrt{y}</annotation></semantics></math>',
    );
  });

  it('accepts static SVG gradients, text, local fragment reuse and a pack image', () => {
    accepts(
      '<svg data-gt="image" viewBox="0 0 100 100" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient><path id="curve" d="M0 0L10 10"/><symbol id="shape"><rect width="10" height="10" fill="url(#gradient)"/></symbol></defs><g><use href="#shape"/><use xlink:href="#shape"/><text><textPath href="#curve"><tspan>label</tspan></textPath></text><image href="logo.svg" width="10" height="10"/></g></svg>',
    );
  });

  it.each([
    'set',
    'animate',
    'animateMotion',
    'animateTransform',
    'foreignObject',
    'style',
    'a',
    'filter',
    'feImage',
  ])(
    'rejects SVG %s instead of admitting active or unsupported SVG content',
    tag =>
      rejects(
        pack(`<svg data-gt="image">\n  <${tag}></${tag}></svg>`),
        'html-unsupported',
        [`<${tag}`],
      ),
  );
  it('blocks the script-free SVG set href mutation bypass', () => {
    rejects(
      pack(
        '<svg data-gt="image"><image id="img" href="logo.svg"/><set href="#img" attributeName="href" to="https://outside.example/image.svg"/></svg>',
      ),
      'html-unsupported',
      ['<set'],
    );
  });
  it.each([
    '<svg data-gt="image"><use href="logo.svg#shape"/></svg>',
    '<svg data-gt="image"><use xlink:href="https://outside.example/x"/></svg>',
    '<svg data-gt="image"><text><textPath href="logo.svg#curve">x</textPath></text></svg>',
    '<svg data-gt="image"><path href="#shape"/></svg>',
    '<math data-gt="field" href="#x"><mi>x</mi></math>',
  ])(
    'refuses nonfragment SVG reuse and href on other SVG/MathML elements: %s',
    template => {
      rejects(pack(template), 'html-unsupported', [
        template.includes('xlink:href') ? 'xlink:href' : 'href',
      ]);
    },
  );
  it('rejects annotation-xml and suppresses its executable HTML subtree', () => {
    rejects(
      pack(
        '<math data-gt="field"><annotation-xml encoding="text/html"><div><script>void 0</script><img src="https://outside.example/x">text</div></annotation-xml></math>',
      ),
      'html-unsupported',
      ['<annotation-xml'],
    );
  });
});

describe('Handlebars cannot change HTML or CSS structure', () => {
  it.each([
    ['attribute name', '<p data-gt="paragraph" {{value}}>text</p>'],
    ['unquoted attribute', '<p data-gt="paragraph" class={{value}}>text</p>'],
    ['start-tag splice', '<scr{{!x}}ipt></scr{{!y}}ipt>'],
    ['end-tag splice', '<p data-gt="paragraph">text</p{{!x}}>'],
    ['dynamic tag', '<{{value}}>'],
    ['comment immediately after less-than', '<{{!x}}script>'],
    ['comment after end-tag prefix', '</{{!x}}p>'],
    ['HTML comment', '<!-- {{value}} {{!comment}} -->'],
    ['multiline long comment', '<!--\n  {{!-- hidden\ncomment --}}\n-->'],
    ['style text', '<style>p { color: {{value}}; }</style>'],
    [
      'partial style URL precedence',
      '<style>p{background:url(logo{{value}}.svg)}</style>',
    ],
    [
      'style comment splicing',
      '<style>p{background:u{{!x}}rl(logo.svg)}</style>',
    ],
    [
      'style attribute',
      '<p data-gt="paragraph" style="color:{{value}}">text</p>',
    ],
    [
      'style URL precedence',
      '<p data-gt="paragraph" style="background:url(\'{{value}}\')">text</p>',
    ],
    [
      'style element URL precedence',
      '<style>p{background:url("{{value}}")}</style>',
    ],
    [
      'block and else in CSS',
      '<style>{{#if value}}p{color:red}{{else}}p{color:blue}{{/if}}</style>',
    ],
    ['block in an HTML comment', '<!-- {{#if value}}x{{else}}y{{/if}} -->'],
    [
      'block in a tag',
      '<p data-gt="paragraph" {{#if value}}class="x"{{else}}id="y"{{/if}}>text</p>',
    ],
  ])(
    'rejects every statement in %s at its original statement location',
    (_name, template) => {
      const result = checkPack(pack(template));
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('pack');
      const expected = [...template.matchAll(/\{\{[\s\S]*?\}\}/g)].map(
        match => ({
          code: 'template-structure',
          file: templateFile,
          ...at(template, match.index),
        }),
      );
      expect(
        result.issues
          .filter(issue => issue.code === 'template-structure')
          .map(({ message, ...issue }) => {
            expect(message.trim()).not.toBe('');
            return issue;
          }),
      ).toEqual(expected);
      expect(result.issues.some(issue => issue.code === 'asset-dynamic')).toBe(
        false,
      );
      for (const location of expected) {
        expect(
          result.issues.filter(
            issue =>
              issue.line === location.line && issue.column === location.column,
          ),
        ).toHaveLength(1);
      }
    },
  );
  it('allows text statements, ordinary comments and whole-element branches', () => {
    accepts(
      '{{!comment}}{{#if value}}<p data-gt="paragraph" class="{{value}}">{{value}}</p>{{else}}<p data-gt="paragraph">empty</p>{{/if}}',
    );
  });
  it('reports a literal mustache path as unsupported instead of throwing TypeError', () => {
    rejects(
      pack('<p data-gt="paragraph">\n  {{1}}</p>'),
      'template-unsupported',
      ['{{1}}'],
    );
  });
});

describe('data URLs cannot hide stylesheets that fetch external resources', () => {
  const url = 'data:text/css,p%7Bbackground:url(https://outside.example/x)%7D';
  it.each([`@import "${url}";`, `@import url("${url}");`])(
    'rejects data stylesheet import %s at its URL',
    css => {
      rejects(
        pack(undefined, `/* heading */\n${css}`),
        'asset-data',
        [url],
        cssFile,
      );
    },
  );
  it('rejects data stylesheet links at their URL', () => {
    rejects(pack(`<link rel="stylesheet" href="${url}">`), 'asset-data', [url]);
  });
  it('rejects inline data imports using the original template URL location', () => {
    rejects(pack(`<style>\n@import "${url}";</style>`), 'asset-data', [url]);
  });
  it('keeps data images in src, srcset, source, SVG image and CSS backgrounds/fonts usable', () => {
    accepts(
      '<picture data-gt="image"><source srcset="data:image/png;base64,AA== 1x"><img src="data:image/png;base64,AA==" srcset="data:image/png;base64,AA== 1x"></picture><svg data-gt="image"><image href="data:image/png;base64,AA=="/></svg><p data-gt="paragraph" style="background:url(data:image/png;base64,AA==)">text</p>',
      '@font-face{font-family:Embedded;src:url(data:font/woff2;base64,AA==)}p{font-family:Embedded;background:url(data:image/png;base64,AA==)}',
    );
  });
});

it('locates 20,000 external CSS references without quadratic source rescanning', () => {
  // Warm parsers before measuring; the bound allows VM scheduling noise while
  // still catching the reviewed multi-second quadratic location algorithm.
  checkPack(pack());
  const count = 20_000;
  const css = Array.from(
    { length: count },
    (_, i) => `.p${i}{background:url(https://outside.example/${i})}`,
  ).join('\n');
  const files = pack(undefined, css);
  const start = performance.now();
  const result = checkPack(files);
  const elapsed = performance.now() - start;
  expect(result.ok).toBe(false);
  expect(result.issues).toHaveLength(count);
  expect(
    result.issues.every(
      issue => issue.code === 'asset-external' && issue.file === cssFile,
    ),
  ).toBe(true);
  expect(result.issues[0]).toMatchObject({ line: 1, column: 20 });
  expect(result.issues.at(-1)).toMatchObject({ line: count, column: 24 });
  expect(elapsed).toBeLessThan(2_000);
}, 15_000);
