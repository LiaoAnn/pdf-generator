import { chromium } from 'playwright-core';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { countOperations } from './operations.ts';

// The scan is the document's budget only if it never counts less than
// pdf.js later produces (T14-10). Chromium prints of what packs draw: text,
// SVG paths and strokes, nested opacity groups, masks, clips, patterns,
// gradients, raster images, links and several pages.

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function print(body: string) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>
      @page { size: 200pt 200pt; margin: 0 }
      body { margin: 0; font: 10pt sans-serif }
      section { height: 200pt; break-after: page; overflow: hidden }
      section:last-child { break-after: auto }
    </style></head><body>${body}</body></html>`);
    // A raster image drawn from a canvas, so no file is fetched.
    await page.evaluate(`(async () => {
      for (const image of document.querySelectorAll('img[data-canvas]')) {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext('2d');
        context.fillStyle = '#c33';
        context.fillRect(0, 0, 4, 8);
        image.src = canvas.toDataURL('image/png');
        await image.decode();
      }
    })()`);
    return new Uint8Array(
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
  } finally {
    await page.close();
  }
}

/** pdf.js's operators for the document, tiling patterns' own lists included, and its deepest form nesting. */
async function pdfjsOperators(pdf: Uint8Array) {
  const { OPS } = await getResolvedPDFJS();
  const document = await getDocumentProxy(new Uint8Array(pdf), {
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  let operators = 0;
  let nesting = 0;
  const walk = (
    list: { fnArray: number[]; argsArray: unknown[] },
    from: number,
  ) => {
    let depth = from;
    operators += list.fnArray.length;
    list.fnArray.forEach((fn, i) => {
      if (fn === OPS.paintFormXObjectBegin)
        nesting = Math.max(nesting, ++depth);
      else if (fn === OPS.paintFormXObjectEnd) depth--;
      const args = list.argsArray[i] as unknown[] | null;
      const inner = args?.[2] as { fnArray?: number[]; argsArray?: unknown[] };
      if (
        (fn === OPS.setFillColorN || fn === OPS.setStrokeColorN) &&
        args?.[0] === 'TilingPattern' &&
        inner?.fnArray &&
        inner.argsArray
      ) {
        walk({ fnArray: inner.fnArray, argsArray: inner.argsArray }, depth);
      }
    });
  };
  try {
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      walk(await page.getOperatorList(), 0);
    }
  } finally {
    await document.loadingTask.destroy();
  }
  return { operators, nesting };
}

const nested = (depth: number) =>
  `${Array.from({ length: depth }, (_, i) => `<g opacity="0.9"><rect x="${i}" y="${i}" width="20" height="20" fill="#${i % 2 ? '333' : '666'}"/>`).join('')}${'</g>'.repeat(depth)}`;

const documents: Record<string, string> = {
  'text, tables and links over three pages': `
    <section><h1>月報 Monthly report</h1>
      <p>王小明 統一編號 12345675，<b>粗體</b>與<i>斜體</i>。</p>
      <table border="1"><tr><td>品項</td><td>金額</td></tr><tr><td>A</td><td>1,234</td></tr></table>
      <a href="https://example.com/a">連結</a></section>
    <section><p style="letter-spacing: 1pt; word-spacing: 4pt">${'第二頁文字 '.repeat(40)}</p></section>
    <section><p style="transform: rotate(30deg)">旋轉的文字</p></section>`,
  'SVG paths, strokes, clips, masks, patterns and gradients': `
    <section><svg width="200pt" height="200pt" viewBox="0 0 200 200">
      <defs>
        <clipPath id="c"><circle cx="50" cy="50" r="30"/></clipPath>
        <mask id="m"><rect width="200" height="200" fill="white"/><circle cx="150" cy="50" r="20" fill="black"/></mask>
        <pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#036"/></pattern>
        <linearGradient id="l"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
        <radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
      </defs>
      <rect width="100" height="100" fill="url(#l)" clip-path="url(#c)"/>
      <rect x="100" width="100" height="100" fill="url(#p)" mask="url(#m)"/>
      <circle cx="50" cy="150" r="40" fill="url(#r)"/>
      <path d="M100 100 C 150 50 200 150 150 200 Z" fill="none" stroke="#000" stroke-width="3" stroke-dasharray="4 2"/>
      ${nested(5)}
    </svg></section>`,
  'CSS backgrounds, shadows, opacity, masks and raster images': `
    <section>
      <div style="width: 80pt; height: 30pt; background: repeating-linear-gradient(45deg, #000 0 2pt, #fff 2pt 4pt)"></div>
      <div style="width: 80pt; height: 30pt; border-radius: 8pt; box-shadow: 2pt 2pt 4pt #888; background: radial-gradient(#f00, #00f)"></div>
      <div style="opacity: 0.5"><div style="opacity: 0.5; mask-image: linear-gradient(#000, transparent); background: #0a0; width: 60pt; height: 20pt"></div></div>
      <img data-canvas width="40" height="40"> <img data-canvas width="20" height="20" style="opacity: 0.3">
      <div style="width: 60pt; height: 20pt; background-image: radial-gradient(circle, #000 1pt, transparent 1pt); background-size: 4pt 4pt"></div>
    </section>`,
  'many rectangles and deep groups': `
    <section><svg width="200pt" height="200pt" viewBox="0 0 100 100">
      ${'<rect width="50" height="50" fill="#000000"/><rect width="50" height="50" fill="#000001"/>'.repeat(1_000)}
      ${nested(40).repeat(3)}
    </svg></section>`,
};

test.each(Object.entries(documents))(
  'the scan never counts fewer operators or less nesting than pdf.js produces: %s',
  async (_, body) => {
    const pdf = await print(body);
    const scan = await countOperations(pdf);
    const actual = await pdfjsOperators(pdf);
    expect(scan.ok, JSON.stringify(scan)).toBe(true);
    if (!scan.ok) return;
    expect(actual.operators).toBeGreaterThan(0);
    expect(scan.operations).toBeGreaterThanOrEqual(actual.operators);
    expect(scan.nesting).toBeGreaterThanOrEqual(actual.nesting);
  },
);
