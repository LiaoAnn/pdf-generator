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
  maskTransfer: svg(
    '<defs><mask id="transfer-mask"><g opacity="0.5"><rect width="100" height="100" fill="white"/><rect width="100" height="100" fill="black"/></g></mask></defs><rect width="100" height="100" mask="url(#transfer-mask)"/>',
  ),
  pattern: svg(
    `<defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="white"/></pattern></defs>${rect} fill="url(#p)"/>`,
  ),
  overpaint: svg(`${rect} fill="black"/>${rect} fill="white"/>`),
  fillOpacity: svg(`${rect} fill-opacity="0.5"/>`),
  opacity: svg(`${rect} opacity="0.5"/>`),
  nestedOpacity: svg(`<g opacity="0.5"><g opacity="0.5">${rect}/></g></g>`),
  axial: svg(
    `<defs><linearGradient id="linear"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>${rect} fill="url(#linear)"/>`,
  ),
  radial: svg(
    `<defs><radialGradient id="radial"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs>${rect} fill="url(#radial)"/>`,
  ),
  clip: svg(
    '<defs><clipPath id="hole"><path clip-rule="evenodd" d="M10 20h60v40H10z M20 30h40v20H20z"/></clipPath></defs><rect width="100" height="100" clip-path="url(#hole)"/>',
  ),
  stroke: svg(
    '<line x1="10" y1="30" x2="70" y2="30" stroke="#123456" stroke-width="4"/>',
  ),
  circle: svg('<circle cx="50" cy="50" r="30"/>'),
  image: '<img data-oracle alt="" />',
  background:
    '<div data-oracle style="position:absolute;left:32px;top:40px;width:100px;height:100px"></div>',
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
        // Known row-major RGBA PNG, generated locally without a dependency.
        await page.evaluate(`(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 2;
          const ctx = canvas.getContext('2d');
          const pixels = ctx.createImageData(2, 2);
          pixels.data.set([255,0,0,255, 0,255,0,255,
            0,0,255,255, 0,0,0,0]);
          ctx.putImageData(pixels, 0, 0);
          const url = canvas.toDataURL('image/png');
          const image = document.querySelector('img');
          if (image) { image.src = url; await image.decode(); }
          const background = document.querySelector('div[data-oracle]');
          if (background) {
            const preload = new Image(); preload.src = url; await preload.decode();
            background.style.backgroundImage = 'url(' + url + ')';
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

test('an SVG pattern fill carries a measurable tile', () => {
  const paint = single('pattern');
  expect(paint.tile).toBeDefined();
  expect(paint.tile?.paints.length).toBeGreaterThan(0);
  expect(paint.unmeasured).toBeUndefined();
  expect(paint.color).toBeUndefined();
  expect(paint.shading).toBeUndefined();
  closeBox(paint.box, expected('pattern', [10, 20, 70, 60]));
});

test.each(['axial', 'radial'] as const)(
  '%s gradient is measurable shading rather than an unsupported tiling pattern',
  name => {
    const paint = single(name);
    expect(paint.shading).toBeDefined();
    expect(paint.tile).toBeUndefined();
  },
);

test('black then white overpaint retains both colours in content-stream order instead of merging their bounds', () => {
  const result = paints('overpaint');
  expect(result).toHaveLength(2);
  expect(result.map(paint => paint.color)).toEqual(['#000000', '#ffffff']);
  for (const paint of result)
    closeBox(paint.box, expected('overpaint', [10, 20, 70, 60]));
});

test.each(['fillOpacity'] as const)(
  '%s preserves half-opacity instead of treating translucent paint as opaque',
  name => {
    expect(single(name).alpha).toBeCloseTo(0.5, 2);
    expect(single(name).groups).toBeUndefined();
  },
);

test.each([
  ['opacity', 1],
  ['nestedOpacity', 2],
] as const)(
  '%s preserves transparency groups separately from the paint alpha',
  (name, count) => {
    const paint = single(name);
    expect(paint.groups).toHaveLength(count);
    expect(paint.alpha).toBe(1);
    for (const group of paint.groups ?? [])
      expect(group.alpha).toBeCloseTo(0.5, 2);
    expect(new Set(paint.groups?.map(group => group.id)).size).toBe(count);
  },
);

test('linear gradient retains axial colours and its page-to-shading geometry', () => {
  const paint = single('axial');
  expect(paint.color).toBeUndefined();
  expect(paint.shading?.kind).toBe('axial');
  const shading = paint.shading;
  if (!shading) throw new Error('missing axial shading');
  expect(shading.stops[0]).toEqual([0, '#ff0000']);
  expect(shading.stops.at(-1)).toEqual([1, '#0000ff']);
  const [a, b, c, d, e, f] = shading.toShading;
  const [x0, y0, x1, y1] = expected('axial', [10, 20, 70, 60]);
  const [dx, dy] = [
    shading.to[0] - shading.from[0],
    shading.to[1] - shading.from[1],
  ];
  for (const [x, offset] of [
    [x0, 0],
    [x1, 1],
  ]) {
    const y = (y0 + y1) / 2;
    const sx = a * (x ?? NaN) + c * y + e - shading.from[0];
    const sy = b * (x ?? NaN) + d * y + f - shading.from[1];
    expect((sx * dx + sy * dy) / (dx * dx + dy * dy)).toBeCloseTo(
      offset ?? NaN,
      2,
    );
  }
});

test('radial gradient retains its radial shading instead of an unknown colour', () => {
  const paint = single('radial');
  expect(paint.color).toBeUndefined();
  expect(paint.shading?.kind).toBe('radial');
  expect(paint.shading?.stops[0]).toEqual([0, '#ff0000']);
  expect(paint.shading?.stops.at(-1)).toEqual([1, '#0000ff']);
});

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
  expect(paint.image).toBeDefined();
  expect(paint.polygons).toHaveLength(1);
  closeBox(
    bounds(paint.polygons[0] ?? []),
    expected('image', [0, 0, 100, 100]),
  );
  closeBox(paint.box, expected('image', [0, 0, 100, 100]));
});

test('a PNG image decodes exact RGBA rows and maps DOM corners to the unit square', () => {
  const image = single('image').image;
  expect(image).toBeDefined();
  if (!image) throw new Error('missing decoded image');
  expect([image.width, image.height]).toEqual([2, 2]);
  expect([...image.rgba]).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0,
  ]);
  const [a, b, c, d, e, f] = image.toImage;
  const [x0, y0, x1, y1] = fixture('image').boxes[0] as Box;
  for (const [x, y, u, v] of [
    [x0, y0, 0, 1],
    [x1, y0, 1, 1],
    [x0, y1, 0, 0],
    [x1, y1, 1, 0],
  ] as const) {
    expect(a * x + c * y + e).toBeCloseTo(u, 2);
    expect(b * x + d * y + f).toBeCloseTo(v, 2);
  }
});

test('a repeating CSS PNG background contains an image paint inside its tile', () => {
  const paint = single('background');
  expect(paint.tile).toBeDefined();
  expect(paint.tile?.paints.some(p => p.image !== undefined)).toBe(true);
  expect(paint.unmeasured).toBeUndefined();
});

test('a Chromium soft-mask transfer map survives readPdf as 256 numeric bytes', () => {
  const masked = paints('maskTransfer').find(paint => paint.mask);
  expect(masked, 'fixture must exercise a real soft mask').toBeDefined();
  const transfer = masked?.mask?.transfer;
  expect(transfer).toHaveLength(256);
  expect(
    transfer?.every(
      value => Number.isInteger(value) && value >= 0 && value <= 255,
    ),
  ).toBe(true);
  // Chromium's inversion must survive too, not merely an invented identity map.
  expect(transfer?.[0]).toBe(255);
  expect(transfer?.[255]).toBe(0);
});

async function largePngDocument(different: boolean) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      @page { size: 200px 200px; margin: 0; }
      body { margin: 0; }
      section { height: 200px; break-after: page; }
      section:last-child { break-after: auto; }
      img { display: block; width: 100px; height: 100px; }
    </style>${'<section><img alt=""></section>'.repeat(3)}`);
    await page.evaluate(`(async () => {
      const different = ${different};
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1500;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('missing canvas context');
      const colors = ['#ff0000', '#00ff00', '#0000ff'];
      let shared;
      for (const [i, image] of [...document.images].entries()) {
        ctx.fillStyle = colors[different ? i : 0] ?? '#000000';
        ctx.fillRect(0, 0, 1500, 1500);
        // An identical data URL lets Chromium reuse the same PDF image ref.
        image.src = shared ?? canvas.toDataURL('image/png');
        if (!different) shared = image.src;
        await image.decode();
      }
    })()`);
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}

test('one large PNG reused on three pages is decoded once and shares RGBA without exhausting the document budget', async () => {
  const document = await readPdf(await largePngDocument(false));
  expect(document.pages).toHaveLength(3);
  const images = document.pages.map(page => {
    expect(page.paints).toHaveLength(1);
    const paint = page.paints[0];
    expect(paint?.unmeasured).toBeUndefined();
    expect(paint?.image).toBeDefined();
    return paint?.image;
  });
  for (const image of images) {
    expect([image?.width, image?.height]).toEqual([1500, 1500]);
    // Compare identity as a boolean: failed assertions must not dump 9 MB.
    expect(
      image?.rgba === images[0]?.rgba,
      'shared image must reuse its RGBA object',
    ).toBe(true);
  }
});

test('different large PNGs on separate pages share one document decoding budget instead of resetting it per page', async () => {
  const document = await readPdf(await largePngDocument(true));
  expect(document.pages).toHaveLength(3);
  for (const [i, page] of document.pages.entries()) {
    expect(page.paints).toHaveLength(1);
    const paint = page.paints[0];
    if (i === 0) {
      expect(paint?.unmeasured).toBeUndefined();
      expect([paint?.image?.width, paint?.image?.height]).toEqual([1500, 1500]);
      expect(paint?.image?.rgba[0]).toBe(255);
      expect(paint?.image?.rgba[1]).toBe(0);
    } else {
      // 2 * 1500^2 > 2^22, even though each individual page fits.
      expect(
        paint?.unmeasured,
        `page ${i + 1} exceeds the document budget`,
      ).toBe(true);
      expect(paint?.image === undefined).toBe(true);
    }
  }
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
  for (const name of ['overpaint', 'image', 'background'] as const) {
    const response = await worker.fetch('http://fixture.test/read', {
      method: 'POST',
      body: new Uint8Array(fixture(name).pdf),
    });
    const result = (await response.json()) as PdfDocument;
    expect(response.status, JSON.stringify(result)).toBe(200);
    const actual = result.pages[0]?.paints;
    if (name === 'image') expect(actual?.[0]?.image).toBeDefined();
    if (name === 'background') expect(actual?.[0]?.tile).toBeDefined();
    expect(actual?.length).toBeGreaterThan(0);
    expect(actual).toHaveLength(paints(name).length); // Comparing two empty stub results must fail.
    // JSON serializes Uint8Array as numeric-key objects; compare the same wire form.
    expect(actual).toEqual(JSON.parse(JSON.stringify(paints(name))));
  }
});
