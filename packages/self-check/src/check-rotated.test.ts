import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { readGroundTruth } from '../../ground-truth/src/index.ts';
import {
  checkPdf,
  type Difference,
  type PdfTextItem,
  readPdf,
} from './index.ts';

const angles = [-90, 90, 180, 30] as const;
interface Fixture {
  pdf: Uint8Array;
  gt: GroundTruth;
  origin: [number, number];
  advance: number;
}
const fixtures = new Map<number, Fixture>();
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const angle of angles) {
      const page = await browser.newPage();
      try {
        await page.setContent(`<!doctype html><html><head><style>
          @page { size: A4; margin: 54pt; }
          body { margin: 0; font: 12pt/24pt "Liberation Sans", sans-serif; }
          .rot { display: inline-block; transform: rotate(${angle}deg); margin: 60pt; }
          .origin { display: inline-block; width: 0; height: 0; }
        </style></head><body>
          <p data-gt="paragraph" data-gt-id="before">Before</p>
          <div class="rot" data-gt="paragraph" data-gt-id="rot"><span class="origin"></span><span class="letters">CONFIDENTIAL</span></div>
        </body></html>`);
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(`window.__pagedDone = false;
          window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
        await page.addScriptTag({ path: polyfill });
        await page.waitForFunction('window.__pagedDone === true');
        await page.evaluate('document.fonts.ready');
        expect(await page.locator('.pagedjs_page').count()).toBe(1);
        const gt = gtSchema.parse(
          await readGroundTruth(page, {
            templateId: 'rotated-self-check',
            templateVersion: 1,
            seed: 'slice-4',
            index: 0,
          }),
        );
        // Independent DOM expectations: the zero-size inline marker sits at
        // the transformed baseline origin. Removing rotation temporarily
        // measures the advance, which the legacy x1 field still adds to x0.
        const measured: { origin: [number, number]; advance: number } =
          await page.evaluate(`(() => {
            const element = document.querySelector('.pagedjs_pages .rot');
            const paper = element.closest('.pagedjs_page').getBoundingClientRect();
            const marker = element.querySelector('.origin').getBoundingClientRect();
            const origin = [(marker.left - paper.left) * .75,
              (marker.top - paper.top) * .75];
            element.style.transform = 'none';
            const advance = element.querySelector('.letters').getBoundingClientRect().width * .75;
            element.style.removeProperty('transform');
            return { origin, advance };
          })()`);
        const pdf = await page.pdf({
          preferCSSPageSize: true,
          printBackground: true,
        });
        fixtures.set(angle, { pdf, gt, ...measured });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

function fixture(angle: number): Fixture {
  const value = fixtures.get(angle);
  if (!value) throw new Error(`No printed fixture for ${angle} degrees`);
  return value;
}

function changedBox(
  angle: number,
  change: (box: number[]) => void,
): GroundTruth {
  const gt = structuredClone(fixture(angle).gt);
  const block = gt.blocks.find(block => block.id === 'rot');
  if (!block) throw new Error('Missing rotated ground-truth block');
  change(block.bbox);
  return gtSchema.parse(gt);
}

function forRotatedBlock(differences: Difference[]): Difference[] {
  return differences.filter(
    difference => 'blockId' in difference && difference.blockId === 'rot',
  );
}

for (const angle of angles) {
  test(`accepts correct DOM ground truth for ${angle}° text instead of inventing a horizontal bbox`, async () => {
    const { pdf, gt } = fixture(angle);
    expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
  });

  test(`still rejects ${angle}° text when its ground-truth box is moved into empty space`, async () => {
    const gt = changedBox(angle, box => {
      box[0] = (box[0] ?? 0) + 150;
      box[2] = (box[2] ?? 0) + 150;
    });
    const result = await checkPdf(fixture(angle).pdf, gt);
    expect(result.ok).toBe(false);
    expect(forRotatedBlock(result.differences).length).toBeGreaterThan(0);
  });

  test(`reports bbox when ${angle}° text protrudes several points from a narrowed box`, async () => {
    const gt = changedBox(angle, box => {
      // Trim both ends of the long axis by 15 pt: the text still overlaps
      // its box, but substantial glyph content lies outside it.
      const axis = Math.abs(angle) === 90 ? 1 : 0;
      box[axis] = (box[axis] ?? 0) + 15;
      box[axis + 2] = (box[axis + 2] ?? 0) - 15;
    });
    const result = await checkPdf(fixture(angle).pdf, gt);
    expect(result.ok).toBe(false);
    expect(forRotatedBlock(result.differences)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'bbox', blockId: 'rot' }),
      ]),
    );
  });

  test(`exposes the ${angle}° advance direction in page coordinates while preserving legacy reader fields`, async () => {
    const { pdf, origin, advance } = fixture(angle);
    const document = await readPdf(pdf);
    const item = document.pages[0]?.items.find(
      item => item.text === 'CONFIDENTIAL',
    );
    expect(item).toBeDefined();
    if (!item) throw new Error('Missing printed CONFIDENTIAL text');
    expect(item.x0).toBeCloseTo(origin[0], 1);
    expect(item.x1).toBeCloseTo(origin[0] + advance, 1);
    expect(item.baseline).toBeCloseTo(origin[1], 1);
    expect(item.size).toBeCloseTo(12, 3);
    expect(item.font).toBe('LiberationSans');
    const dir = (item as PdfTextItem & { dir?: [number, number] }).dir;
    expect(dir).toBeDefined();
    if (!dir) throw new Error('Missing non-horizontal advance direction');
    expect(dir[0]).toBeCloseTo(Math.cos((angle * Math.PI) / 180), 5);
    expect(dir[1]).toBeCloseTo(Math.sin((angle * Math.PI) / 180), 5);
    expect(Math.hypot(...dir)).toBeCloseTo(1, 5);
  });
}

test('horizontal items retain exactly their six legacy keys without an optional dir key', async () => {
  const document = await readPdf(fixture(-90).pdf);
  const item = document.pages[0]?.items.find(item => item.text === 'Before');
  expect(item).toBeDefined();
  expect(Object.keys(item ?? {}).sort()).toEqual(
    ['text', 'x0', 'x1', 'baseline', 'size', 'font'].sort(),
  );
});
