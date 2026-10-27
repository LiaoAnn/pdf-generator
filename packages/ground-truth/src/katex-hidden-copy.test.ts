import { fileURLToPath } from 'node:url';
import type { GroundTruth } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './read.ts';

const source: GroundTruth['source'] = {
  templateId: 'katex-hidden-copy',
  templateVersion: 1,
  seed: 'T07-26',
  index: 0,
};
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);

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
