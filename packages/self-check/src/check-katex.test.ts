import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroundTruth } from '@pdf-generator/contract';
import katex from 'katex';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { readGroundTruth } from '../../ground-truth/src/index.ts';
import { checkPdf, normaliseText, readPdf } from './index.ts';

// Real KaTeX layout, including the paper's accent, delimiters and multi-letter
// operators. Never import the paper builder: its CSS repairs hide this bug.
const formulas = [
  String.raw`x^2_i + \frac{a+b}{c} \tag{7}`,
  String.raw`\hat{y} = \operatorname{softmax}(W \mathbf{h} + b) \tag{1}`,
  String.raw`\mathbf{h}_t = \tanh\left(W_x \mathbf{x}_t + W_h \mathbf{h}_{t-1} + \mathbf{b}\right) \tag{1}`,
  String.raw`\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\left(\frac{Q K^{\top}}{\sqrt{d_k}}\right) V \tag{1}`,
];
const fixtures: { pdf: Uint8Array; gt: GroundTruth }[] = [];

beforeAll(async () => {
  const dist = join(
    dirname(createRequire(import.meta.url).resolve('katex/package.json')),
    'dist',
  );
  // Embed the stock stylesheet's fonts unchanged, avoiding a fixture server
  // or network access. No KaTeX selector or positioning rule is overridden.
  let css = await readFile(join(dist, 'katex.min.css'), 'utf8');
  for (const [url, path] of css.matchAll(/url\((fonts\/[^)]+)\)/g)) {
    if (!path) throw new Error('missing KaTeX font path');
    const bytes = await readFile(join(dist, path));
    css = css.replaceAll(
      url,
      `url(data:font/${path.split('.').at(-1)};base64,${bytes.toString('base64')})`,
    );
  }
  const browser = await chromium.launch({ headless: true });
  try {
    for (const latex of formulas) {
      const page = await browser.newPage();
      try {
        await page.setContent(`<style>${css}
          @page { size: A4; margin: 54pt }
          body { margin: 0; font-size: 12pt }
        </style><div data-gt="formula" data-gt-id="math">${katex.renderToString(latex, { displayMode: true })}</div>`);
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(`window.__pagedDone = false; window.PagedConfig = {
          auto: true, after: () => { window.__pagedDone = true; }
        };`);
        await page.addScriptTag({
          path: fileURLToPath(
            new URL(
              '../dist/paged.polyfill.js',
              import.meta.resolve('pagedjs'),
            ),
          ),
        });
        await page.waitForFunction('window.__pagedDone === true');
        await page.evaluate('document.fonts.ready');
        const gt = await readGroundTruth(page, {
          templateId: 'stock-katex',
          templateVersion: 1,
          seed: 'T14-3',
          index: fixtures.length,
        });
        expect(gt.blocks).toHaveLength(1);
        expect(gt.blocks[0]).toMatchObject({ type: 'formula', latex });
        fixtures.push({
          gt,
          pdf: await page.pdf({
            preferCSSPageSize: true,
            printBackground: true,
          }),
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test.each(formulas.map((latex, index) => ({ latex, index })))(
  'stock KaTeX $latex passes against ground truth read from its printed page',
  async ({ index }) => {
    const fixture = fixtures[index];
    if (!fixture) throw new Error('formula was not printed');
    if (index === 0) {
      // Fixture guard: removing the positioning that causes this regression
      // must not turn this into an ordinary order-preserving formula test.
      const printed = (await readPdf(fixture.pdf)).pages
        .flatMap(page => page.items)
        .map(item => item.text)
        .join('');
      expect(normaliseText(printed)).not.toBe(
        normaliseText(
          (fixture.gt.blocks[0]?.text ?? '').replaceAll('\u200b', ''),
        ),
      );
    }
    expect(await checkPdf(fixture.pdf, fixture.gt)).toEqual({
      ok: true,
      differences: [],
    });
  },
);

test('a real KaTeX PDF still rejects a mutated formula ground-truth character', async () => {
  const fixture = fixtures[0];
  if (!fixture) throw new Error('formula was not printed');
  const gt = structuredClone(fixture.gt);
  const block = gt.blocks[0];
  if (!block) throw new Error('missing formula');
  block.text = block.text.replace('x', 'z');
  const report = await checkPdf(fixture.pdf, gt);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'text',
      blockId: 'math',
      expected: block.text,
    }),
  ]);
});
