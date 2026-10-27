import { gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium } from 'playwright-core';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { checkPdf } from './index.ts';
import { maxClips, maxStructures } from './paints.ts';
import { type PdfDocument, type PdfPaint, readPdf } from './pdf.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function print(sections: string[]) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>
      @page { size: 100pt 100pt; margin: 0 } body { margin: 0 }
      section { height: 100pt; break-after: page }
      section:last-child { break-after: auto }
      svg { display: block; width: 100pt; height: 100pt }
    </style>${sections.map(content => `<section><svg viewBox="0 0 100 100">${content}</svg></section>`).join('')}`);
    return await page.pdf({ preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

// Inspect Chromium's operators independently of readPaints: an optimizer must
// not silently turn a depth regression into a shallow or raster-only fixture.
async function emitted(pdf: Uint8Array) {
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { OPS } = await getResolvedPDFJS();
  const pages: {
    groups: number;
    maxDepth: number;
    maxClips: number;
    structures: number;
    paints: { groups: number; clips: number }[];
  }[] = [];
  try {
    for (let n = 1; n <= document.numPages; n++) {
      const operators = await (await document.getPage(n)).getOperatorList();
      let depth = 0;
      let clips = 0;
      const stack: number[] = [];
      const counts = {
        groups: 0,
        maxDepth: 0,
        maxClips: 0,
        structures: 0,
        paints: [] as { groups: number; clips: number }[],
      };
      for (const [i, fn] of operators.fnArray.entries()) {
        const args = operators.argsArray[i] ?? [];
        if (
          fn === OPS.save ||
          fn === OPS.beginGroup ||
          fn === OPS.paintFormXObjectBegin
        )
          stack.push(clips);
        if (
          fn === OPS.restore ||
          fn === OPS.endGroup ||
          fn === OPS.paintFormXObjectEnd
        )
          clips = stack.pop() ?? clips;
        if (fn === OPS.beginGroup) {
          counts.groups++;
          counts.structures++;
          counts.maxDepth = Math.max(counts.maxDepth, ++depth);
        } else if (fn === OPS.endGroup) depth--;
        if (
          fn === OPS.clip ||
          fn === OPS.eoClip ||
          (fn === OPS.beginGroup && args[0]?.bbox) ||
          (fn === OPS.paintFormXObjectBegin && args[1])
        ) {
          clips++;
          counts.structures++;
          counts.maxClips = Math.max(counts.maxClips, clips);
        }
        if (
          fn === OPS.constructPath &&
          (args[0] === OPS.fill || args[0] === OPS.eoFill)
        )
          counts.paints.push({ groups: depth, clips });
      }
      pages.push(counts);
    }
    return pages;
  } finally {
    await document.loadingTask.destroy();
  }
}

function bounded(paints: PdfPaint[]) {
  expect(
    paints.reduce((max, paint) => Math.max(max, paint.groups?.length ?? 0), 0),
    'retained group references',
  ).toBeLessThanOrEqual(32);
  for (const paint of paints) {
    expect(paint.clips.length, 'retained clip references').toBeLessThanOrEqual(
      32,
    );
  }
}

function tree(depth: number, everyLevel: boolean) {
  return (
    Array.from(
      { length: depth },
      (_, i) =>
        `<g opacity="0.999">${everyLevel || i === depth - 1 ? `<rect x="${2 * i}" y="10" width="1" height="10" fill="${i % 2 ? '#000001' : '#000000'}"/>` : ''}`,
    ).join('') + '</g>'.repeat(depth)
  );
}

let nestedPdf: Uint8Array;
let nested: PdfDocument;
let nestedDepths: { groups: number; clips: number }[];
beforeAll(async () => {
  nestedPdf = await print([tree(40, true).repeat(3), tree(40, false)]);
  const operators = await emitted(nestedPdf);
  expect(operators).toEqual([
    expect.objectContaining({ groups: 120, maxDepth: 40 }),
    expect.objectContaining({ groups: 40, maxDepth: 40 }),
  ]);
  nestedDepths = operators[0]?.paints ?? [];
  expect(nestedDepths.some(paint => paint.clips > 32)).toBe(true);
  expect(
    nestedDepths.some(paint => paint.groups <= 32 && paint.clips <= 32),
  ).toBe(true);
  expect(nestedDepths.map(paint => paint.groups)).toEqual(
    Array.from({ length: 120 }, (_, i) => (i % 40) + 1),
  );
  nested = await readPdf(nestedPdf);
  expect(nested.pages.map(page => page.paints.length)).toEqual([120, 1]);
});

test('rectangles at every level of three 40-group trees cannot retain quadratic group or clip references', () => {
  expect(maxClips).toBe(32);
  bounded(nested.pages.flatMap(page => page.paints));
});

test('excessive group depth is unmeasured even when capped ancestry no longer records the overflow', () => {
  for (const [i, paint] of (nested.pages[0]?.paints ?? []).entries()) {
    if ((i % 40) + 1 > 32) expect(paint.unmeasured).toBe(true);
  }
});

test('group bounding boxes past clip depth 32 are unmeasured even before group depth overflows', () => {
  for (const [i, paint] of (nested.pages[0]?.paints ?? []).entries()) {
    if ((nestedDepths[i]?.clips ?? 0) > 32) expect(paint.unmeasured).toBe(true);
  }
});

test('paints below both ancestry limits retain measured colour and every allowed group', () => {
  const paints = nested.pages[0]?.paints ?? [];
  for (const [i, paint] of paints.entries()) {
    const nesting = nestedDepths[i];
    if (!nesting) throw new Error('missing emitted paint');
    const depth = nesting.groups;
    if (depth <= 32 && nesting.clips <= 32) {
      expect(paint.unmeasured).not.toBe(true);
      expect(paint.color).toBe(i % 2 ? '#000001' : '#000000');
      expect(paint.groups).toHaveLength(depth);
    }
  }
});

test('a textless block painted only past group depth 32 reports cannot measure instead of accepting truncated ancestry', async () => {
  const gt = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'structure-depth',
      templateVersion: 1,
      seed: 'r15',
      index: 0,
    },
    pages: [
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    ],
    blocks: [
      {
        id: 'deep-only',
        type: 'image',
        page: 2,
        order: 0,
        text: '',
        bbox: [78, 10, 79, 20],
      },
    ],
  });
  expect(await checkPdf(nestedPdf, gt)).toEqual({
    ok: false,
    differences: [
      expect.objectContaining({
        kind: 'ink',
        blockId: 'deep-only',
        message: expect.stringContaining("can't measure"),
      }),
    ],
  });
});

test('40 nested nonrectangular SVG clips cannot retain an unbounded clip array or certify black ink', async () => {
  const defs = Array.from(
    { length: 40 },
    (_, i) =>
      `<clipPath id="c${i}"><circle cx="20" cy="20" r="${30 - i / 10}"/></clipPath>`,
  ).join('');
  const groups = Array.from(
    { length: 40 },
    (_, i) => `<g clip-path="url(#c${i})">`,
  ).join('');
  const pdf = await print([
    `<defs>${defs}</defs>${groups}<rect x="15" y="15" width="10" height="10"/>${'</g>'.repeat(40)}`,
  ]);
  expect(
    (await emitted(pdf))[0]?.maxClips,
    'Chromium must really emit all nested clips',
  ).toBeGreaterThanOrEqual(40);
  const document = await readPdf(pdf);
  const paints = document.pages[0]?.paints ?? [];
  expect(paints).toHaveLength(1);
  bounded(paints);
  expect(paints[0]?.unmeasured).toBe(true);
});

let shallowDocument: Promise<PdfDocument> | undefined;
function shallowFixture() {
  shallowDocument ??= readShallowFixture();
  return shallowDocument;
}

async function readShallowFixture() {
  // Each group creates a transparency group and bounding-box clips. Each
  // page is below 2^14 structures; the whole document exceeds it. Only 9,000
  // paints, well below the independent paint and geometry budgets.
  const group =
    '<g opacity="0.999"><rect x="10" y="10" width="10" height="10"/></g>';
  const pdf = await print([
    group.repeat(3_000),
    group.repeat(3_000),
    group.repeat(3_000),
  ]);
  const operators = await emitted(pdf);
  expect(operators).toEqual(
    Array.from({ length: 3 }, () =>
      expect.objectContaining({ groups: 3_000, maxDepth: 1 }),
    ),
  );
  expect(operators.every(page => page.structures < 16_384)).toBe(true);
  expect(
    operators.reduce((sum, page) => sum + page.structures, 0),
  ).toBeGreaterThan(16_384);
  const document = await readPdf(pdf);
  expect(document.pages.map(page => page.paints.length)).toEqual([
    3_000, 3_000, 3_000,
  ]);
  return document;
}

test('separate shallow Chromium groups exhaust one document structure budget across pages without resetting it', async () => {
  const document = await shallowFixture();
  expect(maxStructures).toBe(16_384);
  const paints = document.pages.flatMap(page => page.paints);
  bounded(paints);
  const first = paints[0];
  expect(first?.unmeasured).not.toBe(true);
  expect(first?.color).toBe('#000000');
  expect(
    document.pages[0]?.paints.every(
      paint => !paint.unmeasured && paint.color === '#000000',
    ),
    'the entire first page is below the structure budget',
  ).toBe(true);
  expect(
    paints.at(-1)?.unmeasured,
    'the last page cannot reset the document allowance',
  ).toBe(true);
});

test('exhausting the structure budget stops retaining new groups and clips together instead of only marking their paints unmeasured', async () => {
  const document = await shallowFixture();
  const paints = document.pages.flatMap(page => page.paints);
  const groups = new Set(paints.flatMap(paint => paint.groups ?? []));
  const clips = new Set(paints.flatMap(paint => paint.clips));
  expect(
    groups.size + clips.size,
    'retained groups and clips share one allowance',
  ).toBeLessThanOrEqual(16_384);
});
