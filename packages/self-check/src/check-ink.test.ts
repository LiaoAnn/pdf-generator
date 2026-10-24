import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { type Box, checkPdf, type Difference, readPdf } from './index.ts';

const fixtures = new Map<string, Uint8Array>();
let reference: GroundTruth;
const variants = {
  normal: '',
  'page-frame': '.pagedjs_page { margin-top: -20mm !important; }',
  'body-padding': 'body { padding-left: 10mm; }',
  'barcode-sideways': '#barcode::before { transform: translateX(3pt); }',
  'underline-up':
    '#underline { border: 0; position: relative; } #underline::after { content: ""; position: absolute; left: 0; right: 0; bottom: 4pt; border-bottom: 1pt solid black; }',
};

beforeAll(async () => {
  const html = await readFile(
    new URL('../fixtures/textless-box.html', import.meta.url),
    'utf8',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, css] of Object.entries(variants)) {
      const page = await browser.newPage();
      try {
        await page.setContent(html.replace('/* VARIANT */', css));
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(
          'Promise.all([...document.images].map(image => image.decode()))',
        );
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
        expect(await page.locator('.pagedjs_page').count()).toBe(1);
        if (name === 'normal') {
          // Independent oracle: border boxes from the UNSHIFTED twin only.
          // Do not derive expected GT from readPdf, marks, or shifted DOM.
          const blocks =
            await page.evaluate(`(() => [...document.querySelectorAll('.pagedjs_pages [data-gt]')].map((el, order) => {
            const r = el.getBoundingClientRect();
            const paper = el.closest('.pagedjs_page').getBoundingClientRect();
            return { id: el.id, type: el.dataset.gt, page: 1, order, text: '',
              bbox: [r.left - paper.left, r.top - paper.top, r.right - paper.left, r.bottom - paper.top].map(v => v * .75),
              ...(el.dataset.gt === 'checkbox' ? { checked: false } : {}) };
          }))()`);
          reference = gtSchema.parse({
            schemaVersion: 1,
            source: {
              templateId: 'textless-box',
              templateVersion: 1,
              seed: 'T14-4',
              index: 0,
            },
            pages: [{ width: 595.28, height: 841.89 }],
            blocks,
          });
        }
        const pdf = await page.pdf({
          preferCSSPageSize: true,
          printBackground: true,
        });
        // Setup guard: no accidental alt text or checkbox glyph may turn
        // these into text-based checks.
        expect((await readPdf(pdf)).pages.flatMap(page => page.items)).toEqual(
          [],
        );
        fixtures.set(name, pdf);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

function pdf(name: string) {
  const value = fixtures.get(name);
  if (!value) throw new Error(`fixture not printed: ${name}`);
  return value;
}
function gt(ids: string[]) {
  const value = structuredClone(reference);
  value.blocks = value.blocks.filter(block => ids.includes(block.id));
  value.blocks.forEach((block, order) => {
    block.order = order;
  });
  return gtSchema.parse(value);
}
function diagnostic(difference: Difference) {
  expect(difference.message).toEqual(expect.any(String));
  expect(difference.message.length).toBeGreaterThan(0);
  const { message: _message, ...rest } = difference;
  return rest;
}
function closeBox(actual: Box, expected: Box) {
  actual.forEach((edge, i) => {
    expect(Math.abs(edge - (expected[i] ?? NaN))).toBeLessThanOrEqual(1);
  });
}

// Acceptance first: public checkPdf with real Paged.js/Chromium PDFs.
test.each(['page-frame', 'body-padding'])(
  '%s shift rejects both the text-free PNG and empty checkbox using the unshifted twin GT',
  async name => {
    const expected = gt(['image', 'checkbox']);
    expected.blocks.reverse(); // Diagnostic order follows order, not storage.
    const result = await checkPdf(pdf(name), expected);
    expect(result.ok).toBe(false);
    expect(result.differences.map(diagnostic)).toMatchObject(
      [...expected.blocks]
        .sort((a, b) => a.order - b.order)
        .map(block => ({
          kind: 'ink',
          page: 1,
          blockId: block.id,
          bbox: block.bbox,
        })),
    );
  },
);

test.each(['image', 'checkbox', 'bordered', 'underline', 'barcode'])(
  'unshifted %s passes without a false ink difference',
  async id => {
    expect(await checkPdf(pdf('normal'), gt([id]))).toEqual({
      ok: true,
      differences: [],
    });
  },
);

test('a borderless blank field cannot be verified by the page clip and reports no inkBox', async () => {
  const expected = gt(['blank']);
  const result = await checkPdf(pdf('normal'), expected);
  expect(result.ok).toBe(false);
  expect(result.differences.map(diagnostic)).toEqual([
    {
      kind: 'ink',
      page: 1,
      blockId: 'blank',
      bbox: expected.blocks[0]?.bbox,
    },
  ]);
});

test.each([
  { name: 'barcode-sideways', id: 'barcode', inset: [10, 0, -4, 0] },
  { name: 'underline-up', id: 'underline', inset: [0, 19, 0, -4] },
])(
  '$name rejects ink inside the box that is neither centred nor edge-anchored',
  async ({ name, id, inset }) => {
    const expected = gt([id]);
    const result = await checkPdf(pdf(name), expected);
    expect(result.ok).toBe(false);
    expect(result.differences.map(diagnostic)).toEqual([
      {
        kind: 'ink',
        page: 1,
        blockId: id,
        bbox: expected.blocks[0]?.bbox,
        inkBox: expect.any(Array),
      },
    ]);
    const difference = result.differences[0];
    if (difference?.kind !== 'ink' || !difference.inkBox)
      throw new Error('expected inkBox');
    const box = expected.blocks[0]?.bbox;
    if (!box) throw new Error('missing box');
    closeBox(
      difference.inkBox,
      box.map((edge, i) => edge + (inset[i] ?? 0)) as Box,
    );
  },
);
