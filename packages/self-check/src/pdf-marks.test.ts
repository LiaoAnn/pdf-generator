import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import {
  type PdfDocument,
  type PdfMark,
  type PdfPage,
  readPdf,
} from './index.ts';

type Box = [number, number, number, number];
interface LayoutBox {
  id: string;
  page: number;
  box: Box;
  visible: Box;
}

let pdf: Buffer;
let layout: LayoutBox[];
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 640, height: 800 },
    });
    await page.goto(
      new URL('../fixtures/marks-geometry.html', import.meta.url).href,
    );
    await page.emulateMedia({ media: 'print' });
    // Independent oracle: DOM border boxes, plus the @page margins which screen
    // DOM geometry excludes. Subtract each section's origin to reset page two.
    layout = await page.evaluate(`(async () => {
      await Promise.all(Array.from(document.images, image => image.decode()));
      const pageRule = Array.from(document.styleSheets[0].cssRules)
        .find(rule => rule.cssText.startsWith('@page'));
      const left = parseFloat(pageRule.style.marginLeft);
      const top = parseFloat(pageRule.style.marginTop);
      return Array.from(document.querySelectorAll('[data-box]'), element => {
        const section = element.closest('section');
        const origin = section.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const toPoints = bounds => [
          bounds.left - origin.left + left, bounds.top - origin.top + top,
          bounds.right - origin.left + left, bounds.bottom - origin.top + top,
        ].map(value => value * 0.75);
        let visible = rect;
        if (element.parentElement.classList.contains('clip-parent')) {
          const clip = element.parentElement.getBoundingClientRect();
          visible = {
            left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top),
            right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom),
          };
        }
        return { id: element.id, page: Number(section.dataset.page),
          box: toPoints(rect), visible: toPoints(visible) };
      });
    })()`);
    pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(layout).toHaveLength(12);
  } finally {
    await browser.close();
  }
});

afterAll(async () => {
  await worker?.dispose();
});

function oracle(id: string): LayoutBox {
  const found = layout.find(item => item.id === id);
  if (!found) throw new Error(`missing DOM oracle: ${id}`);
  return found;
}

function marksOf(page: PdfPage): PdfMark[] {
  expect(page.marks, 'readPdf must report non-text marks').toBeInstanceOf(
    Array,
  );
  return page.marks;
}

function near(actual: Box, expected: Box): boolean {
  return actual.every(
    (value, index) => Math.abs(value - (expected[index] ?? NaN)) <= 1,
  );
}

function expectMark(
  marks: PdfMark[],
  expected: LayoutBox,
  kinds: PdfMark['kind'][],
  box = expected.box,
) {
  expect(
    marks.some(mark => kinds.includes(mark.kind) && near(mark.box, box)),
    `${expected.id}: expected ${kinds.join('/')} at DOM box ${JSON.stringify(box)}; got ${JSON.stringify(marks)}`,
  ).toBe(true);
}

function expectGeometry(document: PdfDocument) {
  expect(document.pages).toHaveLength(2);
  const first = document.pages[0];
  if (!first) throw new Error('missing first page');
  const marks = marksOf(first);
  expectMark(marks, oracle('png'), ['image']);
  for (const id of ['svg-image', 'inline-svg']) {
    expectMark(marks, oracle(id), ['clip', 'path']);
  }
  for (const id of ['checkbox', 'border', 'background']) {
    expectMark(marks, oracle(id), ['path']);
  }
  const [x0, , x1, bottom] = oracle('underline').box;
  expect(
    marks.some(
      mark =>
        mark.kind === 'path' &&
        Math.abs(mark.box[0] - x0) <= 1 &&
        Math.abs(mark.box[2] - x1) <= 1 &&
        Math.abs(mark.box[3] - bottom) <= 1 &&
        mark.box[3] - mark.box[1] > 0 &&
        mark.box[3] - mark.box[1] <= 2 &&
        Math.abs(mark.box[1] - bottom) <= 2,
    ),
    'underline must span the field width at its bottom edge, not its empty height',
  ).toBe(true);

  const bare = oracle('bare').box;
  expect(
    marks.filter(
      mark =>
        mark.box[0] >= bare[0] - 1 &&
        mark.box[1] >= bare[1] - 1 &&
        mark.box[2] <= bare[2] + 1 &&
        mark.box[3] <= bare[3] + 1,
    ),
    'an unpainted element has no mark',
  ).toEqual([]);
  for (const page of document.pages) {
    expect(page.items, 'fixture has no printed text').toEqual([]);
    for (const mark of marksOf(page)) {
      const [left, top, right, bottom] = mark.box;
      expect(mark.box.every(Number.isFinite), 'finite mark coordinates').toBe(
        true,
      );
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(page.width);
      expect(bottom).toBeLessThanOrEqual(page.height);
      expect(right).toBeGreaterThanOrEqual(left);
      expect(bottom).toBeGreaterThanOrEqual(top);
    }
  }
}

// Acceptance boundary first: real Chromium PDF bytes through the same public
// reader in workerd as the deployed self-check, without mocking PDF operators.
test('workerd reports DOM-sized PNG, SVG, checkbox, border, underline and background marks, but no bare-element mark', async () => {
  worker = await unstable_startWorker({
    entrypoint: fileURLToPath(import.meta.resolve('./test-worker.ts')),
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      // In memory: by default both workerd tests (this file and pdf.test.ts
      // run in parallel) keep state in the repo root's .wrangler/state, and
      // the second workerd failed to start with SQLITE_BUSY (T07-21).
      persist: false,
    },
  });
  await worker.url;
  const response = await worker.fetch('http://fixture.test/read', {
    method: 'POST',
    body: new Uint8Array(pdf),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expectGeometry(result as PdfDocument);
});

test('Node reports the same drawn geometry instead of dropping text-free content', async () => {
  expectGeometry(await readPdf(pdf));
});

test('page-two marks use the MediaBox top-left with nonzero @page margins, not document or content-area coordinates', async () => {
  const document = await readPdf(pdf);
  expect(document.pages).toHaveLength(2);
  const expected = oracle('page-two');
  const second = document.pages[expected.page - 1];
  if (!second) throw new Error('missing second page');
  expectMark(marksOf(second), expected, ['path']);
  const first = document.pages[0];
  if (!first) throw new Error('missing first page');
  expect(marksOf(first).some(mark => near(mark.box, expected.box))).toBe(false);
});

test.each([
  { id: 'clipped-path', kind: 'path' as const },
  { id: 'clipped-image', kind: 'image' as const },
])(
  'overflow clips $kind marks to the visible half and suppresses fully hidden paint',
  async ({ id, kind }) => {
    const document = await readPdf(pdf);
    const first = document.pages[0];
    if (!first) throw new Error('missing first page');
    const marks = marksOf(first);
    const expected = oracle(id);
    expect(expected.visible[2] - expected.visible[0]).toBe(
      (expected.box[2] - expected.box[0]) / 2,
    );
    expectMark(marks, expected, [kind], expected.visible);
    expect(
      marks.some(mark => mark.kind === kind && near(mark.box, expected.box)),
      'the unclipped child box must not survive',
    ).toBe(false);
    const hidden = oracle('fully-hidden').box;
    expect(
      marks.filter(
        mark =>
          mark.kind !== 'clip' &&
          Math.min(mark.box[2], hidden[2]) - Math.max(mark.box[0], hidden[0]) >
            1 &&
          Math.min(mark.box[3], hidden[3]) - Math.max(mark.box[1], hidden[1]) >
            1,
      ),
      'fully clipped paint must not be reported',
    ).toEqual([]);
  },
);
