import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { readGroundTruth } from '../../ground-truth/src/index.ts';
import { checkPdf, readPdf } from './index.ts';

const cases = [
  { name: 'Latin label/value', texts: ['Name:', 'Alice Chen'] },
  {
    name: 'CJK label/value',
    texts: ['姓名：', '王小明'],
    font: '"WenQuanYi Zen Hei"',
  },
  { name: 'three adjacent blocks', texts: ['Name:', 'Alice', 'Chen'] },
  {
    name: 'single-space separator',
    texts: ['Name:', 'Alice Chen'],
    separator: ' ',
  },
  {
    name: 'value wrapping after the shared first line',
    texts: ['Name:', 'Alice Chen lives in Taipei City'],
    width: 150,
    wrapped: 'val',
    sharedText: 'Name:Alice',
  },
  {
    name: 'first block wrapping before the shared second line',
    texts: ['Alice Chen lives in Taipei City ', 'END'],
    width: 150,
    wrapped: 'lbl',
    sharedText: 'City END',
  },
  {
    name: 'both blocks wrapping around the shared middle line',
    texts: ['Alice Chen lives in Taipei City', 'Bob accounting@example.com'],
    width: 150,
    wrapped: 'both',
    sharedText: 'CityBob',
  },
];
const ids = ['lbl', 'val', 'tail'];
const fixtures = new Map<string, { pdf: Uint8Array; gt: GroundTruth }>();

function fixture(name = 'Latin label/value') {
  const value = fixtures.get(name);
  if (!value) throw new Error(`fixture not printed: ${name}`);
  return value;
}

function block(gt: GroundTruth, id: string) {
  const value = gt.blocks.find(block => block.id === id);
  if (!value) throw new Error(`missing block: ${id}`);
  return value;
}

beforeAll(async () => {
  const html = await readFile(
    new URL('../fixtures/adjacent-inline.html', import.meta.url),
    'utf8',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of cases) {
      const page = await browser.newPage();
      try {
        const spans = scenario.texts.map(
          (text, i) =>
            `<span data-gt="${i === 0 ? 'label' : 'field'}" data-gt-id="${ids[i]}">${text}</span>`,
        );
        await page.setContent(
          html
            .replace('WIDTH', String(scenario.width ?? 360))
            .replace('FONT', scenario.font ?? '"Liberation Sans"')
            .replace('BLOCKS', spans.join(scenario.separator ?? '')),
        );
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
        const gt = gtSchema.parse(
          await readGroundTruth(page, {
            templateId: 'adjacent-inline',
            templateVersion: 1,
            seed: 'T14-1',
            index: fixtures.size,
          }),
        );
        expect(gt.blocks.map(block => block.text)).toEqual(
          scenario.texts.map(text => text.trim()),
        );
        if (scenario.wrapped === 'both') {
          // Measure the printed DOM independently of the PDF text layer.
          const multiline = await page.evaluate(`Array.from(
            document.querySelectorAll('.pagedjs_page [data-gt]'),
            element => element.getBoundingClientRect().height >
              Number.parseFloat(getComputedStyle(element).lineHeight)
          )`);
          expect(multiline).toEqual([true, true]);
        }
        const pdf = await page.pdf({
          preferCSSPageSize: true,
          printBackground: true,
        });
        fixtures.set(scenario.name, { pdf, gt });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

// Acceptance at the package's public entry point, using independently read DOM
// ground truth. readPdf is only a guard that Chrome still reproduces the bug.
test.each(cases)(
  'correct $name passes when Chrome merges adjacent blocks into one text item',
  async scenario => {
    const { pdf, gt } = fixture(scenario.name);
    const pages = (await readPdf(pdf)).pages;
    expect(pages).toHaveLength(1);
    const items = pages.flatMap(page => page.items);
    if (scenario.wrapped) {
      expect(items).toHaveLength(scenario.wrapped === 'both' ? 3 : 2);
      expect(items.some(item => item.text.includes(scenario.sharedText))).toBe(
        true,
      );
      const wrapped = block(
        gt,
        scenario.wrapped === 'both' ? 'lbl' : scenario.wrapped,
      );
      // A single inline's bounding box must really span both 24pt lines.
      expect(wrapped.bbox[3] - wrapped.bbox[1]).toBeGreaterThan(24);
      if (scenario.wrapped === 'both') {
        const value = block(gt, 'val');
        expect(value.bbox[3] - value.bbox[1]).toBeGreaterThan(24);
      }
      if (scenario.wrapped === 'lbl') {
        expect(block(gt, 'val').bbox[1] - wrapped.bbox[1]).toBeCloseTo(24, 1);
      }
    } else {
      expect(items.map(item => item.text)).toEqual([
        scenario.texts.join(scenario.separator ?? ''),
      ]);
      if (scenario.font) {
        expect(items[0]?.font).toMatch(/WenQuanYiZenHei/i);
      }
    }
    expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
  },
);

test.each([
  {
    name: 'second block text wrong at its start',
    affected: 'val',
    change: (gt: GroundTruth) => {
      block(gt, 'val').text = 'Rob accounting@example.com';
    },
  },
  {
    name: 'first block text wrong at its end',
    affected: 'lbl',
    change: (gt: GroundTruth) => {
      block(gt, 'lbl').text = 'Alice Chen lives in Taipei Town';
    },
  },
  {
    name: 'second block box moved down one line height',
    affected: 'val',
    change: (gt: GroundTruth) => {
      const box = block(gt, 'val').bbox;
      box[1] += 24;
      box[3] += 24;
    },
  },
])('$name is rejected when both adjacent blocks wrap', async scenario => {
  const { pdf, gt: correct } = fixture(
    'both blocks wrapping around the shared middle line',
  );
  const gt = structuredClone(correct);
  scenario.change(gt);
  const report = await checkPdf(pdf, gtSchema.parse(gt));
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ blockId: scenario.affected }),
    ]),
  );
});

const mutations: {
  name: string;
  affected: string[];
  change: (gt: GroundTruth) => void;
  textDifference?: boolean;
}[] = [
  {
    name: 'wrong label character',
    affected: ['lbl'],
    textDifference: true,
    change: gt => {
      block(gt, 'lbl').text = 'Nane:';
    },
  },
  {
    name: 'swapped label/value texts',
    affected: ['lbl', 'val'],
    change: gt => {
      const label = block(gt, 'lbl');
      const value = block(gt, 'val');
      [label.text, value.text] = [value.text, label.text];
    },
  },
  {
    name: 'value box shifted right by 20pt',
    affected: ['val'],
    change: gt => {
      const box = block(gt, 'val').bbox;
      box[0] += 20;
      box[2] += 20;
    },
  },
  {
    name: 'value box moved down one line',
    affected: ['val'],
    change: gt => {
      const box = block(gt, 'val').bbox;
      box[1] += 24;
      box[3] += 24;
    },
  },
  {
    name: 'both boxes shifted right together by 30pt',
    affected: ['lbl', 'val'],
    change: gt => {
      for (const block of gt.blocks) {
        block.bbox[0] += 30;
        block.bbox[2] += 30;
      }
    },
  },
];

test.each(mutations)(
  '$name is still rejected when the printed text item crosses the block boundary',
  async ({ affected, change, textDifference }) => {
    const { pdf, gt: correct } = fixture();
    expect(
      (await readPdf(pdf)).pages.flatMap(page =>
        page.items.map(item => item.text),
      ),
    ).toEqual(['Name:Alice Chen']);
    const gt = structuredClone(correct);
    change(gt);
    const report = await checkPdf(pdf, gtSchema.parse(gt));
    expect(report.ok).toBe(false);
    expect(
      report.differences.some(
        difference =>
          'blockId' in difference &&
          affected.includes(difference.blockId) &&
          (!textDifference || difference.kind === 'text'),
      ),
    ).toBe(true);
  },
);
