import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type Box, checkPdf, readPdf } from './index.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

// DOM measurements are independent of readPdf's operator interpretation.
async function print(content: string) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>
      @page { size: 400px 400px; margin: 0 }
      body { margin: 0 } #block { position: absolute; left: 80px; top: 80px }
    </style>${content}`);
    await page.emulateMedia({ media: 'print' });
    const bbox = await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      canvas.getContext('2d').fillRect(0, 0, 16, 16);
      for (const img of document.querySelectorAll('img[data-raster]')) img.src = canvas.toDataURL('image/png');
      await Promise.all([...document.images].map(img => img.decode()));
      const r = document.querySelector('#block').getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom].map(n => n * 0.75);
    })()`);
    const pdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
    const gt: GroundTruth = gtSchema.parse({
      schemaVersion: 1,
      source: {
        templateId: 'paint-regressions',
        templateVersion: 1,
        seed: 'T14-4',
        index: 0,
      },
      pages: [{ width: 300, height: 300 }],
      blocks: [
        { id: 'block', type: 'image', page: 1, order: 0, text: '', bbox },
      ],
    });
    return { pdf, gt, bbox: bbox as Box };
  } finally {
    await page.close();
  }
}

async function expectNoInk(content: string) {
  const { pdf, gt, bbox } = await print(content);
  const result = await checkPdf(pdf, gt);
  expect.soft(result).toEqual({
    ok: false,
    differences: [
      {
        kind: 'ink',
        page: 1,
        blockId: 'block',
        bbox,
        message: expect.any(String),
      },
    ],
  });
}

test('a dashless SVG clip alone cannot pass a text-free block or supply inkBox', async () => {
  await expectNoInk(
    '<svg id="block" data-gt="image" width="100" height="100"><path d="M0 50 H100" stroke="black" stroke-width="10" stroke-dasharray="0 200"/></svg>',
  );
});

test.each(['fill', 'stroke'] as const)(
  'fully transparent SVG %s cannot verify a block or supply inkBox',
  async paint => {
    const shape =
      paint === 'fill'
        ? '<rect x="10" y="10" width="80" height="80" fill="black" fill-opacity="0"/>'
        : '<rect x="10" y="10" width="80" height="80" fill="none" stroke="black" stroke-width="4" stroke-opacity="0"/>';
    await expectNoInk(
      `<svg id="block" data-gt="image" width="100" height="100">${shape}</svg>`,
    );
    const { pdf } = await print(
      `<svg id="block" width="100" height="100">${shape}</svg>`,
    );
    expect(
      (await readPdf(pdf)).pages[0]?.marks.filter(mark => mark.kind === 'path'),
    ).toEqual([]);
  },
);

test('an opacity-zero raster image cannot verify a block or supply inkBox', async () => {
  const content =
    '<img id="block" data-gt="image" data-raster width="100" height="100" style="opacity: 0">';
  await expectNoInk(content);
  const { pdf } = await print(content);
  expect(
    (await readPdf(pdf)).pages[0]?.marks.filter(mark => mark.kind === 'image'),
  ).toEqual([]);
});

test.each(['fill', 'stroke', 'image'] as const)(
  'half-opacity %s remains painted ink rather than being discarded with zero opacity',
  async kind => {
    const content =
      kind === 'image'
        ? '<img id="block" data-gt="image" data-raster width="100" height="100" style="opacity: 0.5">'
        : `<svg id="block" data-gt="image" width="100" height="100"><rect x="10" y="10" width="80" height="80" ${kind === 'fill' ? 'fill="black" fill-opacity="0.5"' : 'fill="none" stroke="black" stroke-width="4" stroke-opacity="0.5"'}/></svg>`;
    const { pdf, gt } = await print(content);
    expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
    expect(
      (await readPdf(pdf)).pages[0]?.marks.some(
        mark => mark.kind === (kind === 'image' ? 'image' : 'path'),
      ),
    ).toBe(true);
  },
);

test('an SVG image clip still anchors its small painted circle within the full image box', async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="30" cy="35" r="5"/></svg>';
  const { pdf, gt } = await print(
    `<img id="block" data-gt="image" width="100" height="100" src="data:image/svg+xml,${encodeURIComponent(svg)}">`,
  );
  expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
});

test('nonuniform scaling preserves the horizontal stroke width instead of using determinant scaling', async () => {
  const { pdf } = await print(
    '<svg id="block" width="200" height="150"><path d="M 10 20 L 10 100" transform="scale(4 1)" fill="none" stroke="black" stroke-width="4"/></svg>',
  );
  const paths =
    (await readPdf(pdf)).pages[0]?.marks.filter(mark => mark.kind === 'path') ??
    [];
  expect(paths).toHaveLength(1);
  const box = paths[0]?.box;
  if (!box) throw new Error('missing stroked path');
  // 4 user units × horizontal scale 4 × CSS px-to-pt 0.75.
  expect(Math.abs(box[2] - box[0] - 12)).toBeLessThanOrEqual(1);
});

test('a raster rotated 30 degrees uses all four corners for its axis-aligned image bounds', async () => {
  const { pdf, bbox } = await print(
    '<img id="block" data-raster width="100" height="60" style="transform: rotate(30deg)">',
  );
  const images =
    (await readPdf(pdf)).pages[0]?.marks.filter(
      mark => mark.kind === 'image',
    ) ?? [];
  expect(images).toHaveLength(1);
  const actual = images[0]?.box;
  if (!actual) throw new Error('missing rotated image');
  for (let i = 0; i < 4; i++)
    expect(Math.abs((actual[i] ?? NaN) - (bbox[i] ?? NaN))).toBeLessThanOrEqual(
      1,
    );
});
