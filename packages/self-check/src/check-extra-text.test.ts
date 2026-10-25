import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { readGroundTruth } from '../../ground-truth/src/index.ts';
import { type Box, checkPdf, type Difference } from './index.ts';

const fixtures = new Map<boolean, { pdf: Uint8Array; gt: GroundTruth }>();

beforeAll(async () => {
  const html = await readFile(
    new URL('../fixtures/extra-text.html', import.meta.url),
    'utf8',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const extra of [true, false]) {
      const page = await browser.newPage();
      try {
        await page.setContent(extra ? html : html.replace('class="note"', ''));
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(`window.__pagedDone = false;
          window.PagedConfig = {
            auto: true,
            after: () => { window.__pagedDone = true; }
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
        const gt = await readGroundTruth(page, {
          templateId: 'extra-text',
          templateVersion: 1,
          seed: 'T14-1',
          index: 0,
        });
        expect(gt.blocks.map(block => [block.id, block.text])).toEqual([
          ['title', 'Intro'],
          ['note', 'Note'],
        ]);
        fixtures.set(extra, {
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

function fixture(extra: boolean) {
  const value = fixtures.get(extra);
  if (!value) throw new Error('fixture was not printed');
  return value;
}

function note(gt: GroundTruth) {
  const block = gt.blocks.find(block => block.id === 'note');
  if (!block) throw new Error('missing note block');
  return block;
}

function contained(inner: Box, outer: Box) {
  return (
    inner[0] >= outer[0] - 1 &&
    inner[1] >= outer[1] - 1 &&
    inner[2] <= outer[2] + 1 &&
    inner[3] <= outer[3] + 1
  );
}

function expectHonestBoxes(differences: Difference[]) {
  for (const difference of differences) {
    if (difference.kind === 'bbox') {
      expect(
        contained(difference.textBox, difference.bbox),
        difference.message,
      ).toBe(false);
    }
  }
}

test('generated text inside a block is one text mismatch with all printed content, not bbox or unmarked text', async () => {
  const { pdf, gt } = fixture(true);
  const report = await checkPdf(pdf, gt);
  expect(report.ok).toBe(false);
  expect(
    report.differences.map(({ message, ...difference }) => {
      expect(message.length).toBeGreaterThan(0);
      return difference;
    }),
  ).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'note',
      expected: 'Note',
      actual: 'Note（extra not in gt）',
    },
  ]);
  expectHonestBoxes(report.differences);
});

test.each([
  {
    name: 'entirely outside a box moved to an empty area',
    box: [300, 300, 480, 324] as Box,
  },
  {
    name: 'partly outside a narrowed box',
    // CSS puts the note at x=54 pt. A 18 pt box cuts several points off
    // the 12 pt sans-serif word, while keeping its centre inside the box.
    box: undefined,
  },
])(
  'text $name still reports bbox rather than a text mismatch',
  async ({ box }) => {
    const { pdf, gt: original } = fixture(false);
    expect(await checkPdf(pdf, original)).toEqual({
      ok: true,
      differences: [],
    });
    const gt = structuredClone(original);
    const block = note(gt);
    block.bbox = box ?? [54, block.bbox[1], 72, block.bbox[3]];
    const report = await checkPdf(pdf, gtSchema.parse(gt));
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      {
        kind: 'bbox',
        page: 1,
        blockId: 'note',
        bbox: block.bbox,
        textBox: expect.any(Array),
        message: expect.any(String),
      },
    ]);
    expectHonestBoxes(report.differences);
  },
);
