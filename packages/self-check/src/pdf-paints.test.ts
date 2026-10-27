import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { type PdfDocument, type PdfPaint, readPdf } from './pdf.ts';

type Box = [number, number, number, number];
const svg = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" data-oracle>${content}</svg>`;
const rect = '<rect x="10" y="20" width="60" height="40"';
const sources = {
  corners: svg('<path d="M0 0h1v1H0z M99 99h1v1h-1z"/>'),
  evenodd: svg(
    '<path fill-rule="evenodd" d="M10 20h60v40H10z M20 30h40v20H20z"/>',
  ),
  nonzero: svg('<path d="M10 20h60v40H10z M20 30h40v20H20z"/>'),
  white: svg(`${rect} fill="white"/>`),
  overpaint: svg(`${rect} fill="black"/>${rect} fill="white"/>`),
  fillOpacity: svg(`${rect} fill-opacity="0.5"/>`),
  opacity: svg(`${rect} opacity="0.5"/>`),
  clip: svg(
    '<defs><clipPath id="hole"><path clip-rule="evenodd" d="M10 20h60v40H10z M20 30h40v20H20z"/></clipPath></defs><rect width="100" height="100" clip-path="url(#hole)"/>',
  ),
  stroke: svg(
    '<line x1="10" y1="30" x2="70" y2="30" stroke="#123456" stroke-width="4"/>',
  ),
  circle: svg('<circle cx="50" cy="50" r="30"/>'),
  image: '<img data-oracle alt="" />',
  pages: `${svg(`${rect} fill="#ff0000"/>`)}</section><section>${svg('<rect x="40" y="60" width="20" height="10" fill="#0000ff"/>')}`,
};
type Fixture = keyof typeof sources;
const fixtures = new Map<
  Fixture,
  { pdf: Uint8Array; boxes: Box[]; document: PdfDocument }
>();
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

beforeAll(async () => {
  const html = await readFile(
    new URL('../fixtures/paint-geometry.html', import.meta.url),
    'utf8',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, source] of Object.entries(sources)) {
      const page = await browser.newPage({
        viewport: { width: 320, height: 400 },
      });
      try {
        await page.setContent(
          html.replace('<!-- PAINT -->', `<section>${source}</section>`),
        );
        await page.emulateMedia({ media: 'print' });
        // Generate an opaque PNG locally; no external image or service.
        await page.evaluate(`(async () => {
          const image = document.querySelector('img');
          if (image) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 8;
            canvas.getContext('2d').fillRect(0, 0, 8, 8);
            image.src = canvas.toDataURL('image/png');
            await image.decode();
          }
        })()`);
        // DOM positions are independent of the PDF reader. Reset at each
        // section and add the CSS @page margin before converting px to pt.
        const boxes: Box[] =
          await page.evaluate(`Array.from(document.querySelectorAll('[data-oracle]'), element => {
          const r = element.getBoundingClientRect();
          const origin = element.closest('section').getBoundingClientRect();
          return [r.left - origin.left + 16, r.top - origin.top + 16,
            r.right - origin.left + 16, r.bottom - origin.top + 16].map(n => n * 0.75);
        })`);
        const pdf = await page.pdf({
          preferCSSPageSize: true,
          printBackground: true,
        });
        fixtures.set(name as Fixture, {
          pdf,
          boxes,
          document: await readPdf(pdf),
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

afterAll(async () => {
  await worker?.dispose();
});

function fixture(name: Fixture) {
  const found = fixtures.get(name);
  if (!found) throw new Error(`missing fixture: ${name}`);
  return found;
}

function paints(name: Fixture, page = 0): PdfPaint[] {
  const found = fixture(name).document.pages[page];
  if (!found) throw new Error(`missing page ${page}`);
  return found.paints;
}

function expected(name: Fixture, local: Box, page = 0): Box {
  const origin = fixture(name).boxes[page];
  if (!origin) throw new Error('missing DOM box');
  return [
    origin[0] + local[0] * 0.75,
    origin[1] + local[1] * 0.75,
    origin[0] + local[2] * 0.75,
    origin[1] + local[3] * 0.75,
  ];
}

function closeBox(actual: Box, wanted: Box) {
  actual.forEach((edge, index) => {
    expect(Math.abs(edge - (wanted[index] ?? NaN))).toBeLessThanOrEqual(0.5);
  });
}

function bounds(polygon: number[]): Box {
  expect(polygon.length).toBeGreaterThanOrEqual(6);
  expect(polygon.length % 2).toBe(0);
  expect(polygon.every(Number.isFinite)).toBe(true);
  const xs = polygon.filter((_, i) => i % 2 === 0);
  const ys = polygon.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function single(name: Fixture): PdfPaint {
  const result = paints(name);
  expect(
    result,
    `${name}: one content-stream paint, not clips or a bounding rectangle`,
  ).toHaveLength(1);
  const paint = result[0];
  if (!paint) throw new Error('missing paint');
  return paint;
}

test('two corner squares stay two tiny subpaths of one paint instead of a full SVG bounding rectangle', () => {
  const paint = single('corners');
  expect(paint.polygons).toHaveLength(2);
  const boxes = paint.polygons.map(bounds).sort((a, b) => a[0] - b[0]);
  closeBox(boxes[0] as Box, expected('corners', [0, 0, 1, 1]));
  closeBox(boxes[1] as Box, expected('corners', [99, 99, 100, 100]));
  closeBox(paint.box, expected('corners', [0, 0, 100, 100]));
});

test.each([
  { name: 'evenodd', rule: 'evenodd' },
  { name: 'nonzero', rule: 'nonzero' },
] as const)(
  '$name fill preserves its winding rule instead of filling every hole as nonzero',
  ({ name, rule }) => {
    const paint = single(name);
    expect(paint.rule).toBe(rule);
    expect(paint.polygons).toHaveLength(2);
    const boxes = paint.polygons.map(bounds).sort((a, b) => a[0] - b[0]);
    closeBox(boxes[0] as Box, expected(name, [10, 20, 70, 60]));
    closeBox(boxes[1] as Box, expected(name, [20, 30, 60, 50]));
  },
);

test('white fill is reported as white instead of being treated as black ink or omitted', () => {
  const paint = single('white');
  expect(paint.color).toBe('#ffffff');
  closeBox(paint.box, expected('white', [10, 20, 70, 60]));
});

test('black then white overpaint retains both colours in content-stream order instead of merging their bounds', () => {
  const result = paints('overpaint');
  expect(result).toHaveLength(2);
  expect(result.map(paint => paint.color)).toEqual(['#000000', '#ffffff']);
  for (const paint of result)
    closeBox(paint.box, expected('overpaint', [10, 20, 70, 60]));
});

test.each(['fillOpacity', 'opacity'] as const)(
  '%s preserves half-opacity instead of treating translucent paint as opaque',
  name => {
    expect(single(name).alpha).toBeCloseTo(0.5, 2);
  },
);

test('even-odd clip retains its hole geometry instead of just the clipping bounding rectangle', () => {
  const paint = single('clip');
  const clip = paint.clips.find(shape => shape.rule === 'evenodd');
  expect(clip, 'clip-rule must survive with both contours').toBeDefined();
  if (!clip) throw new Error('missing even-odd clip');
  expect(clip.polygons).toHaveLength(2);
  const boxes = clip.polygons.map(bounds).sort((a, b) => a[0] - b[0]);
  closeBox(boxes[0] as Box, expected('clip', [10, 20, 70, 60]));
  closeBox(boxes[1] as Box, expected('clip', [20, 30, 60, 50]));
  closeBox(paint.box, expected('clip', [10, 20, 70, 60]));
});

test('stroke becomes a widened outline in points instead of a zero-area centreline or fill-colour shape', () => {
  const paint = single('stroke');
  expect(paint.color).toBe('#123456');
  expect(paint.polygons).toHaveLength(1);
  closeBox(
    bounds(paint.polygons[0] ?? []),
    expected('stroke', [10, 28, 70, 32]),
  );
  closeBox(paint.box, expected('stroke', [10, 28, 70, 32]));
});

test('circle curves flatten into a curved contour instead of the circle bounding rectangle', () => {
  const paint = single('circle');
  expect(paint.polygons).toHaveLength(1);
  const polygon = paint.polygons[0] ?? [];
  expect(polygon.length).toBeGreaterThan(10);
  closeBox(bounds(polygon), expected('circle', [20, 20, 80, 80]));
  closeBox(paint.box, expected('circle', [20, 20, 80, 80]));
  const center = expected('circle', [50, 50, 50, 50]);
  for (let i = 0; i < polygon.length; i += 2) {
    const radius = Math.hypot(
      (polygon[i] ?? NaN) - center[0],
      (polygon[i + 1] ?? NaN) - center[1],
    );
    expect(Math.abs(radius - 22.5)).toBeLessThanOrEqual(0.5);
  }
});

test('raster image reports one transformed rectangular paint without inventing a solid colour', () => {
  const paint = single('image');
  expect(paint.color).toBeUndefined();
  expect(paint.polygons).toHaveLength(1);
  closeBox(
    bounds(paint.polygons[0] ?? []),
    expected('image', [0, 0, 100, 100]),
  );
  closeBox(paint.box, expected('image', [0, 0, 100, 100]));
});

test('page paints reset their geometry and colour at each page instead of leaking page-one state', () => {
  expect(fixture('pages').document.pages).toHaveLength(2);
  for (const [page, color, box] of [
    [0, '#ff0000', [10, 20, 70, 60]],
    [1, '#0000ff', [40, 60, 60, 70]],
  ] as const) {
    const result = paints('pages', page);
    expect(result).toHaveLength(1);
    expect(result[0]?.color).toBe(color);
    closeBox(result[0]?.box as Box, expected('pages', [...box], page));
  }
});

test('workerd preserves real nonempty paint geometry and colour identically to Node instead of dropping paints at the runtime boundary', async () => {
  worker = await unstable_startWorker({
    entrypoint: fileURLToPath(import.meta.resolve('./test-worker.ts')),
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      persist: false,
    },
  });
  await worker.url;
  const response = await worker.fetch('http://fixture.test/read', {
    method: 'POST',
    body: new Uint8Array(fixture('overpaint').pdf),
  });
  const result = (await response.json()) as PdfDocument;
  expect(response.status, JSON.stringify(result)).toBe(200);
  const actual = result.pages[0]?.paints;
  expect(actual).toHaveLength(2); // Comparing two empty stub results must fail.
  expect(actual).toEqual(paints('overpaint'));
});
