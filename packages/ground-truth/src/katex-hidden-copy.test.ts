import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroundTruth } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './read.ts';

// Exercise the installed renderer and stylesheet without adding a dependency
// to this package: KaTeX belongs to the print app.
const printRequire = createRequire(
  new URL('../../../apps/print/package.json', import.meta.url),
);
const realKatex: {
  renderToString: (latex: string, options: { displayMode: boolean }) => string;
} = printRequire('katex');

const source: GroundTruth['source'] = {
  templateId: 'katex-hidden-copy',
  templateVersion: 1,
  seed: 'T07-26',
  index: 0,
};
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);

test.each(['paragraph', 'table cell'])(
  'round 6 preserves printed case when generated content swaps in a %s',
  async context => {
    const content =
      '<span class="copy katex-mathml"><math><mtext>AaA</mtext></math></span><div class="first">a</div><div class="second">a</div>';
    await withPrintedPage(
      context === 'paragraph'
        ? `<div data-gt="paragraph">${content}</div>`
        : `<table data-gt="table"><tbody><tr><td>${content}</td></tr></tbody></table>`,
      async page => {
        const block = page.locator('.pagedjs_page [data-gt]');
        // Generated X consumes ::first-letter on the first div. Moving it to
        // the second div swaps aA to Aa without changing either div's style.
        expect((await block.innerText()).replace(/\s/g, '')).toBe('AaAaA');
        const result = await readGroundTruth(page, source);
        const text = result.blocks[0]?.text.replace(/\s/g, '');
        expect(text?.slice(-2)).toBe('aA');
        if (context === 'table cell') {
          const table = result.blocks[0];
          if (table?.type !== 'table') throw new Error('Expected table');
          expect(table.table.cells[0]?.text.replace(/\s/g, '').slice(-2)).toBe(
            'aA',
          );
        }
        // The temporary reader edit must also restore the printed state.
        expect((await block.innerText()).replace(/\s/g, '')).toBe('AaAaA');
      },
      `.copy { position:absolute;display:block;width:1px;height:1px;left:100px;top:100px;overflow:hidden;overflow-clip-margin:0px;clip:rect(1px,1px,1px,1px);padding:0;border:0 }
       .first::first-letter,.second::first-letter { text-transform:uppercase }
       .first::before { content:"X" }
       .second::before { content:none }
       .katex-mathml[style]~.first::before { content:none }
       .katex-mathml[style]~.second::before { content:"X" }`,
    );
  },
  30_000,
);

const paintRegressions = [
  {
    name: 'text-shadow paints an offscreen MathML copy inside the clip',
    text: 'SHADOW',
    css: '.clip { display:block; width:200px; height:60px; overflow:hidden } math { display:block; position:relative; left:-200px; width:180px } mtext { text-shadow:210px 0 black; font:24px sans-serif }',
  },
  {
    name: 'vertical ink overflows a CSS-sized one-pixel token',
    text: 'VERTICAL',
    css: '.clip { display:block; height:100px; overflow:hidden } math { display:block; width:180px; height:20px } mtext { display:block; width:180px; height:1px; position:relative; top:-10px; font:30px/100px sans-serif }',
  },
  {
    name: 'first-line shadow escapes the token box',
    text: 'FIRSTLINE',
    css: '.clip { display:block; width:200px; height:60px; overflow:hidden } math { display:block; position:relative; left:-200px; width:180px } p::first-line { text-shadow:210px 0 black }',
  },
  {
    name: 'italic glyph overhang paints inside a large clip despite an outside MathML box',
    text: 'f',
    css: '.clip { display:block; position:relative; width:200px; height:180px; overflow:hidden } math { position:relative; left:-35px } mtext { font:italic 100px serif }',
  },
  ...[
    {
      name: 'static wrapper does not seal overflowing MathML',
      css: 'position:static',
    },
    {
      name: 'relative wrapper does not seal overflowing MathML',
      css: 'position:relative',
    },
    {
      name: 'visible horizontal overflow does not seal the wrapper',
      css: 'overflow-x:visible',
    },
    {
      name: 'visible vertical overflow does not seal the wrapper',
      css: 'overflow-y:visible',
    },
    {
      name: 'overflow clip margin permits ink beyond the wrapper',
      css: 'overflow:clip;overflow-clip-margin:20px',
    },
    {
      name: 'two-pixel wrapper exceeds the hidden-copy limit',
      css: 'width:2px',
    },
    {
      name: 'wrapper transform enlarges its one-pixel clip',
      css: 'transform:scale(50);transform-origin:top left',
    },
    {
      name: 'ancestor transform enlarges the one-pixel clip',
      css: '',
      ancestor:
        '.ancestor { transform:scale(50);transform-origin:top left;display:inline-block;width:1px;height:1px }',
    },
    {
      name: 'display contents has no sealing wrapper box',
      css: 'display:contents',
    },
    {
      name: 'inline wrapper does not seal its content',
      css: 'position:static;display:inline',
    },
    {
      name: 'fixed-position descendant prevents the wrapper exemption',
      css: '',
      descendant:
        '.pagedjs_page { --desc-position:fixed } .fixed { position:var(--desc-position,static) }',
    },
    // Keep token boxes tiny while their text overflows: this isolates the text
    // guard from the independent element-clipping check. An axis set to visible
    // computes to auto when the other axis is hidden; it still is not sealed.
  ].map(({ name, css, ancestor = '', descendant = '' }) => ({
    name,
    text: 'UNSEALED',
    css: `.clip { display:block;position:absolute;width:1px;height:1px;overflow:hidden;overflow-clip-margin:0px;padding:0;border:0;${css} } ${ancestor} .fixed { display:contents } math, mtext { display:block;width:1px;height:1px } ${descendant}`,
  })),
];

test.each(paintRegressions)(
  'retains paragraph text when $name',
  async ({ name, css, text }) => {
    await withPrintedPage(
      `<p data-gt="paragraph"><span class="ancestor"><span class="clip katex-mathml"><span class="fixed"><math><mtext>${text}</mtext></math></span></span></span></p>`,
      async page => {
        if (name.startsWith('fixed-position')) {
          expect(
            await page
              .locator('.pagedjs_page .fixed')
              .evaluate(element => getComputedStyle(element).position),
          ).toBe('fixed');
        }
        if (name.startsWith('italic glyph')) {
          const math = await page.locator('.pagedjs_page math').boundingBox();
          const clip = await page.locator('.pagedjs_page .clip').boundingBox();
          expect(math).not.toBeNull();
          expect(clip).not.toBeNull();
          if (!math || !clip)
            throw new Error('Expected laid-out overhang fixture');
          expect(math.x + math.width).toBeLessThanOrEqual(clip.x);
        }
        const result = await readGroundTruth(page, source);
        expect(result.blocks[0]?.text).toContain(text);
      },
      css,
    );
  },
  30_000,
);

test.each([
  {
    name: 'locale changes outside the copy',
    copy: 'IİI',
    visible:
      '<span class="visible"><span class="first">i</span><span class="second">i</span></span>',
    printed: 'İI',
    css: '.visible span { text-transform:uppercase } .first { -webkit-locale:"tr" } .second { -webkit-locale:"en" } .katex-mathml[style*="none"] ~ .visible .first { -webkit-locale:"en" } .katex-mathml[style*="none"] ~ .visible .second { -webkit-locale:"tr" }',
  },
  {
    name: 'first-letter transformations outside the copy',
    copy: 'aAa',
    visible:
      '<span class="visible first">a</span><span class="visible second">A</span>',
    printed: 'Aa',
    css: '.visible { display:inline-block;width:20px;height:20px } .first::first-letter { text-transform:uppercase } .second::first-letter { text-transform:lowercase } .katex-mathml[style*="none"] ~ .first::first-letter { text-transform:lowercase } .katex-mathml[style*="none"] ~ .second::first-letter { text-transform:uppercase }',
  },
])(
  'round 5 preserves printed text despite $name',
  async ({ copy, visible, printed, css }) => {
    await withPrintedPage(
      `<div data-gt="paragraph"><span class="clip katex-mathml"><math><mtext>${copy}</mtext></math></span>${visible}</div>`,
      async page => {
        const block = page.locator('.pagedjs_page [data-gt]');
        // Chromium innerText reflects the printed case transformations. Establish
        // the pre-edit oracle before asking the reader to mutate the wrappers.
        expect((await block.innerText()).replace(/\s/g, '')).toBe(
          copy + printed,
        );
        const result = await readGroundTruth(page, source);
        expect(
          result.blocks[0]?.text.replace(/\s/g, '').slice(-printed.length),
        ).toBe(printed);
      },
      `${sealingCss} .clip { overflow-clip-margin:0px } ${css}`,
    );
  },
  30_000,
);

test.each([
  {
    name: 'fieldset legend',
    markup:
      '<fieldset class="clip katex-mathml"><legend><math><mtext>REQUIRED</mtext></math></legend></fieldset>',
  },
  {
    name: 'MathML wrapper',
    markup: '<math class="clip katex-mathml"><mtext>REQUIRED</mtext></math>',
  },
  {
    name: 'flex wrapper',
    markup:
      '<span class="clip katex-mathml" style="display:flex"><math><mtext>REQUIRED</mtext></math></span>',
  },
  {
    name: 'two-pixel height',
    markup:
      '<span class="clip katex-mathml" style="height:2px"><math><mtext>REQUIRED</mtext></math></span>',
  },
  {
    name: 'HTML alone',
    markup: '<span class="clip katex-mathml"><span>REQUIRED</span></span>',
  },
  {
    name: 'HTML alongside MathML',
    markup:
      '<span class="clip katex-mathml"><span>REQUIRED</span><math><mtext>COPY</mtext></math></span>',
  },
])(
  'round 5 retains text from $name in blocks and cells',
  async ({ name, markup }) => {
    await withPrintedPage(
      `<div data-gt="paragraph">${markup}</div><table data-gt="table"><tbody><tr><td>${markup}</td></tr></tbody></table>`,
      async page => {
        if (name === 'fieldset legend') {
          const box = await page
            .locator('.pagedjs_page fieldset')
            .first()
            .boundingBox();
          expect(box?.width).toBe(1);
          expect(box?.height).toBe(1);
        }
        const result = await readGroundTruth(page, source);
        expect(result.blocks).toHaveLength(2);
        for (const block of result.blocks)
          expect(block.text).toContain('REQUIRED');
        const table = result.blocks.find(block => block.type === 'table');
        expect(table?.table.cells[0]?.text).toContain('REQUIRED');
      },
      `${sealingCss} .clip { overflow-clip-margin:0px;min-inline-size:0 } math, mtext, legend { display:block;width:1px;height:1px;padding:0;border:0 }`,
    );
  },
  30_000,
);

test.each([null, 'color: rgb(1, 2, 3); display: block !important;'])(
  'round 5 restores the exact wrapper style attribute %s',
  async style => {
    await withPrintedPage(
      `<div data-gt="paragraph"><span class="clip katex-mathml"${style === null ? '' : ` style="${style}"`}><math><mtext>COPY</mtext></math></span><span class="visible">PRINTED</span></div>`,
      async page => {
        const wrapper = page.locator('.pagedjs_page .katex-mathml');
        expect(await wrapper.getAttribute('style')).toBe(style);
        await readGroundTruth(page, source);
        expect(await wrapper.getAttribute('style')).toBe(style);
        expect(await page.locator('.pagedjs_page .visible').isVisible()).toBe(
          true,
        );
        expect(await page.locator('.pagedjs_page .visible').innerText()).toBe(
          'PRINTED',
        );
      },
      `${sealingCss} .katex-mathml[style*="none"] ~ .visible { display:none }`,
    );
  },
  30_000,
);

const sealedPaintRegressions = [
  { name: 'CSS height', css: 'mtext { height:1px }' },
  { name: 'block display', css: 'mtext { display:block }' },
  { name: 'negative letter spacing', css: 'mtext { letter-spacing:-100px }' },
  { name: 'text stroke', css: 'mtext { -webkit-text-stroke:4px black }' },
  { name: 'text emphasis', css: 'mtext { text-emphasis:filled dot }' },
  {
    name: 'token drop shadow',
    css: 'mtext { filter:drop-shadow(10px 0 black) }',
  },
  { name: 'token reflection', css: 'mtext { -webkit-box-reflect:below }' },
  {
    name: 'ancestor drop shadow',
    css: '.clip { filter:drop-shadow(10px 0 black) }',
  },
];
const sealingCss =
  '.clip { display:block;position:absolute;clip:rect(1px,1px,1px,1px);padding:0;border:0;height:1px;width:1px;overflow:hidden }';

test.each(sealedPaintRegressions)(
  'excludes a sealed copy despite $name on its content',
  async ({ css }) => {
    await withPrintedPage(
      '<p data-gt="paragraph">PRINTED<span class="clip katex-mathml"><math><mtext>SEALED</mtext></math></span></p>',
      async page => {
        const result = await readGroundTruth(page, source);
        expect(result.blocks[0]?.text.replace(/\s/g, '')).toBe('PRINTED');
      },
      `${sealingCss} ${css}`,
    );
  },
  30_000,
);

test.each([false, true])(
  'real KaTeX CSS removes the MathML copy (displayMode=%s)',
  async displayMode => {
    const cssPath = printRequire.resolve('katex/dist/katex.min.css');
    let css = await readFile(cssPath, 'utf8');
    for (const url of new Set(
      [...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]),
    )) {
      if (!url) continue;
      const bytes = await readFile(join(dirname(cssPath), url));
      css = css.replaceAll(
        `url(${url})`,
        `url(data:font/woff2;base64,${bytes.toString('base64')})`,
      );
    }
    const formula = realKatex.renderToString(String.raw`\frac{a}{b}+x^2`, {
      displayMode,
    });
    await withPrintedPage(
      `<div data-gt="${displayMode ? 'formula' : 'paragraph'}">${formula}</div>`,
      async page => {
        expect(
          await page.locator('.pagedjs_page [data-gt]').innerText(),
        ).toContain('𝑎');
        const visible = await page
          .locator('.pagedjs_page .katex-html')
          .innerText();
        const result = await readGroundTruth(page, source);
        expect(result.blocks[0]?.text.replace(/\s/g, '')).toBe(
          displayMode
            ? visible.replace(/[\s\u200b]/g, '')
            : visible.replace(/\s/g, ''),
        );
        expect(result.blocks[0]?.text).not.toContain('𝑎');
        expect(result.blocks[0]?.text).not.toContain('frac');
      },
      css,
    );
  },
  30_000,
);

const hiddenCopy =
  '<span class="katex katex-mathml" style="position:absolute;clip:rect(1px,1px,1px,1px);padding:0;border:0;height:1px;width:1px;overflow:hidden"><math><mtext>COPY</mtext></math></span>';

test.each([
  {
    name: 'sibling selector reacting to a temporary display:none style',
    css: '.katex-mathml[style*="none"] ~ .visible { display:none }',
  },
  {
    name: 'has selector reacting to a temporary display:none style',
    css: 'p:has(.katex-mathml[style*="none"]) .visible { display:none }',
  },
])(
  'preserves printed text despite $name',
  async ({ css }) => {
    await withPrintedPage(
      `<p data-gt="paragraph">${hiddenCopy}<span class="visible">PRINTED</span></p>`,
      async page => {
        expect(await page.locator('.pagedjs_page .visible').innerText()).toBe(
          'PRINTED',
        );
        const result = await readGroundTruth(page, source);
        expect(result.blocks[0]?.text).toContain('PRINTED');
      },
      css,
    );
  },
  30_000,
);

test('ABA copy removal cannot disguise a CSS swap from printed BA to AB', async () => {
  await withPrintedPage(
    `<p data-gt="paragraph">${hiddenCopy.replace('COPY', 'ABA')}<span class="before">BA</span><span class="after">AB</span></p>`,
    async page => {
      expect(await page.locator('.pagedjs_page .before').innerText()).toBe(
        'BA',
      );
      const result = await readGroundTruth(page, source);
      const text = result.blocks[0]?.text.replace(/\s/g, '');
      expect(text).toContain('BA');
      expect(text).not.toBe('AB');
    },
    '.after { display:none } .katex-mathml[style*="none"] ~ .before { display:none } .katex-mathml[style*="none"] ~ .after { display:inline }',
  );
}, 30_000);

test('CSS transitions reacting to reader mutations cannot corrupt the printed paragraph box', async () => {
  await withPrintedPage(
    `<p data-gt="paragraph">${hiddenCopy}<span class="visible">PRINTED</span></p>`,
    async page => {
      const printed = await page.locator('.pagedjs_page p').boundingBox();
      expect(printed?.width).toBe(500);
      const result = await readGroundTruth(page, source);
      const box = result.blocks[0]?.bbox;
      expect(box).toBeDefined();
      if (!box) throw new Error('Expected paragraph bbox');
      expect(box[2] - box[0]).toBe(375);
      expect(result.blocks[0]?.text).toContain('PRINTED');
    },
    'p[data-gt] { width:500px; transition:width 10s -5s } p:has(.katex-mathml[style*="none"]) { width:100px }',
  );
}, 30_000);

test('a data-gt MathML wrapper does not expose the unprinted LaTeX annotation', async () => {
  await withPrintedPage(
    inlineKatex.replace(
      'class="katex-mathml"',
      'class="katex-mathml" data-gt="paragraph"',
    ),
    async page => {
      const result = await readGroundTruth(page, source);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]?.text).not.toContain(String.raw`\frac{a}{b}+x^2`);
      // A source-only marker distinguishes annotation text from visible tokens.
      expect(result.blocks[0]?.text).not.toContain('frac');
    },
  );
}, 30_000);

test('a one-pixel MathML parent with horizontally overflowing text stays in ground truth', async () => {
  await withPrintedPage(
    '<p data-gt="paragraph"><span class="katex-mathml"><math><mtext style="width:1px;height:1px">LONGTEXT</mtext></math></span></p>',
    async page => {
      const result = await readGroundTruth(page, source);
      expect(result.blocks[0]?.text).toContain('LONGTEXT');
    },
  );
}, 30_000);

test('checkbox cell labels exclude the hidden inline KaTeX copy', async () => {
  await withPrintedPage(
    `<table data-gt="table"><tbody><tr><td><span data-gt-checked="true">☑</span>前文${inlineKatex}後文</td></tr></tbody></table>`,
    async page => {
      const result = await readGroundTruth(page, source);
      const table = result.blocks[0];
      if (table?.type !== 'table') throw new Error('Expected table');
      expect(table.table.cells[0]?.checkboxes).toHaveLength(1);
      expect(table.table.cells[0]?.checkboxes?.[0]?.checked).toBe(true);
      expect(table.table.cells[0]?.checkboxes?.[0]?.text).toBe(
        '前文ba\u200b+x2後文',
      );
    },
  );
}, 30_000);

// Pre-rendered by apps/print's installed KaTeX: renderToString('\\frac{a}{b}+x^2').
// Keep the actual MathML/HTML shape without a ground-truth dependency on KaTeX.
const inlineKatex = String.raw`<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>+</mo><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\frac{a}{b}+x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:1.0404em;vertical-align:-0.345em;"></span><span class="mord"><span class="mopen nulldelimiter"></span><span class="mfrac"><span class="vlist-t vlist-t2"><span class="vlist-r"><span class="vlist" style="height:0.6954em;"><span style="top:-2.655em;"><span class="pstrut" style="height:3em;"></span><span class="sizing reset-size6 size3 mtight"><span class="mord mtight"><span class="mord mathnormal mtight">b</span></span></span></span><span style="top:-3.23em;"><span class="pstrut" style="height:3em;"></span><span class="frac-line" style="border-bottom-width:0.04em;"></span></span><span style="top:-3.394em;"><span class="pstrut" style="height:3em;"></span><span class="sizing reset-size6 size3 mtight"><span class="mord mtight"><span class="mord mathnormal mtight">a</span></span></span></span></span><span class="vlist-s">​</span></span><span class="vlist-r"><span class="vlist" style="height:0.345em;"><span></span></span></span></span></span><span class="mclose nulldelimiter"></span></span><span class="mspace" style="margin-right:0.2222em;"></span><span class="mbin">+</span><span class="mspace" style="margin-right:0.2222em;"></span></span><span class="base"><span class="strut" style="height:0.8141em;"></span><span class="mord"><span class="mord mathnormal">x</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist" style="height:0.8141em;"><span style="top:-3.063em;margin-right:0.05em;"><span class="pstrut" style="height:2.7em;"></span><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span></span></span></span></span></span></span></span></span>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function withPrintedPage(
  body: string,
  run: (page: Page) => Promise<void>,
  css = '',
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.emulateMedia({ media: 'print' });
    await page.setContent(`<!doctype html><html><head><style>
      @page { size: 600pt 800pt; margin: 60pt 48pt; }
      html, body { margin: 0; padding: 0; }
      * { box-sizing: border-box; }
      body { font: 10pt/12pt sans-serif; }
      [data-gt] { width: 300pt; height: 48pt; margin: 0; padding: 0; }
      table { border-collapse: collapse; table-layout: fixed; }
      td { height: 48pt; padding: 0; }
      .katex .katex-mathml {
        position: absolute; clip: rect(1px, 1px, 1px, 1px);
        padding: 0; border: 0; width: 1px; height: 1px; overflow: hidden;
      }
      ${css}
      </style></head><body>${body}</body></html>`);
    await page.evaluate(`window.__pagedDone = false;
      window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
    await page.addScriptTag({ path: polyfill });
    await page.waitForFunction('window.__pagedDone === true');
    await run(page);
  } finally {
    await page.close();
  }
}

describe('T07-26 readGroundTruth excludes only the hidden KaTeX MathML copy', () => {
  test('excludes hidden inline MathML from paragraph text without changing visible HTML or its box', async () => {
    await withPrintedPage(
      `<p data-gt="paragraph" data-gt-id="paragraph">前文${inlineKatex}後文</p>`,
      async page => {
        // Establish that Chrome exposes the hidden copy: this must not pass
        // merely because a fixture used display:none instead of KaTeX's clip.
        expect(
          await page.locator('.pagedjs_page [data-gt]').innerText(),
        ).toContain('𝑎');
        const result = await readGroundTruth(page, source);
        expect(result.blocks).toEqual([
          {
            id: 'paragraph',
            type: 'paragraph',
            page: 1,
            order: 0,
            bbox: [48, 60, 348, 108],
            text: '前文ba\u200b+x2後文',
          },
        ]);
      },
    );
  }, 30_000);

  test('removes two inline copies in order without deleting surrounding paragraph text', async () => {
    await withPrintedPage(
      `<p data-gt="paragraph">前文${inlineKatex}中間${inlineKatex}後文</p>`,
      async page => {
        const result = await readGroundTruth(page, source);
        expect(result.blocks[0]?.text).toBe(
          '前文ba\u200b+x2中間ba\u200b+x2後文',
        );
      },
    );
  }, 30_000);

  test('excludes hidden inline MathML from both table block and cell text while preserving their boxes', async () => {
    await withPrintedPage(
      `<table data-gt="table" data-gt-id="table"><tbody><tr><td>前文${inlineKatex}後文</td></tr></tbody></table>`,
      async page => {
        expect(await page.locator('.pagedjs_page td').innerText()).toContain(
          '𝑎',
        );
        const result = await readGroundTruth(page, source);
        const block = result.blocks[0];
        if (block?.type !== 'table') throw new Error('Expected a table block');
        // Separate assertions expose a partial fix of only one collection path.
        expect.soft(block?.text).toBe('前文ba\u200b+x2後文');
        expect.soft(block?.table?.cells[0]?.text).toBe('前文ba\u200b+x2後文');
        expect(block?.bbox).toEqual([48, 60, 348, 108]);
        expect(block?.table?.cells[0]?.bbox).toEqual([48, 60, 348, 108]);
      },
    );
  }, 30_000);

  test.each([
    {
      name: 'plain HTML with the katex-mathml class',
      markup: '<span class="katex-mathml">VISIBLE_HTML</span>',
      text: 'VISIBLE_HTML',
    },
    {
      name: 'visible pack-owned MathML with the katex-mathml class',
      markup:
        '<span class="katex-mathml"><math><mtext>VISIBLE_MATHML</mtext></math></span>',
      text: 'VISIBLE_MATHML',
    },
    {
      name: 'a 1px MathML wrapper whose text overflows horizontally',
      markup:
        '<span class="katex-mathml" style="display:inline-block; width:1px; height:1px; overflow:visible"><math><mtext>VISIBLE_OVERFLOW</mtext></math></span>',
      text: 'VISIBLE_OVERFLOW',
    },
  ])(
    'preserves $name in paragraph and cell text',
    async ({ markup, text }) => {
      await withPrintedPage(
        `<p data-gt="paragraph">${markup}</p><table data-gt="table"><tbody><tr><td>${markup}</td></tr></tbody></table>`,
        async page => {
          const result = await readGroundTruth(page, source);
          expect(result.blocks.map(block => block.text)).toEqual([text, text]);
          const table = result.blocks.find(block => block.type === 'table');
          expect(table?.table.cells[0]?.text).toBe(text);
        },
      );
    },
    30_000,
  );

  test('retains x-tex annotation LaTeX and visible formula parts when excluding its hidden copy', async () => {
    await withPrintedPage(
      `<div data-gt="formula" data-gt-id="formula">${inlineKatex}</div>`,
      async page => {
        const result = await readGroundTruth(page, source);
        expect(result.blocks).toEqual([
          {
            id: 'formula',
            type: 'formula',
            page: 1,
            order: 0,
            bbox: [48, 60, 348, 108],
            text: 'ba+x2',
            latex: String.raw`\frac{a}{b}+x^2`,
          },
        ]);
        // Reading must leave the source available to later readers/printing.
        expect(
          await page.locator('.pagedjs_page annotation').textContent(),
        ).toBe(String.raw`\frac{a}{b}+x^2`);
      },
    );
  }, 30_000);
});
