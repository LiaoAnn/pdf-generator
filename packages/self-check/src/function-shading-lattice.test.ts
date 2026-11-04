import { chromium } from 'playwright-core';
import { getDocumentProxy } from 'unpdf';
import { expect, test } from 'vitest';

// Canary (T14-11). Chromium prints a CSS repeating-linear-gradient as a
// function-based shading (ShadingType 1) whose function repeats once per
// domain unit, under a luminosity soft mask drawn the same way. pdf.js turns
// such a shading into a lattice with one vertex per domain unit, so every
// vertex lands on the same phase of the stripes and the box reads solid or
// blank (PDFium draws the stripes: `pnpm compare-renderers`). The self-check
// reads this lattice, so the template spec forbids repeating linear
// gradients rather than the self-check measuring them.
//
// Here the shading spans the 200 pt page in 4 pt periods, 50 domain units,
// so the steps are exactly one unit (with px periods they drift slowly
// instead, and the box reads as shifting bands).
//
// If this test fails, pdf.js changed how it samples these shadings: compare
// the renderers again (T14-11's evidence in its PR) before relaxing the spec
// rule or trusting the self-check on such blocks.

type Mesh = [
  'Mesh',
  number,
  Float32Array,
  Uint8ClampedArray | Uint8Array,
  number,
  ...unknown[],
];

test("pdf.js samples Chromium's repeating-gradient shadings once per period", async () => {
  const browser = await chromium.launch({ headless: true });
  let pdf: Uint8Array;
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      @page { size: 200pt 100pt; margin: 0 } body { margin: 0; padding: 20pt }
    </style><div style="width: 75pt; height: 30pt; print-color-adjust: exact;
      background: repeating-linear-gradient(90deg, black 0 2pt, transparent 2pt 4pt)"></div>`);
    pdf = new Uint8Array(
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
  } finally {
    await browser.close();
  }

  // The shadings the page's tiling pattern fills with, by id, as pdf.js
  // resolved them.
  const document = await getDocumentProxy(new Uint8Array(pdf), {
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  const meshes: Mesh[] = [];
  try {
    const page = await document.getPage(1);
    const ids = new Set<string>();
    const walk = (list: { fnArray: number[]; argsArray: unknown[] }) => {
      for (const args of list.argsArray as (unknown[] | null)[]) {
        if (args?.[0] === 'Shading' && typeof args[1] === 'string')
          ids.add(args[1]);
        const inner = args?.[2] as {
          fnArray?: number[];
          argsArray?: unknown[];
        };
        if (args?.[0] === 'TilingPattern' && inner?.fnArray && inner.argsArray)
          walk({ fnArray: inner.fnArray, argsArray: inner.argsArray });
      }
    };
    walk(await page.getOperatorList());
    for (const id of ids) meshes.push(page.objs.get(id) as Mesh);
  } finally {
    await document.loadingTask.destroy();
  }

  // The fill and its soft mask: two function-based (type 1) meshes.
  expect(meshes.map(([kind, type]) => [kind, type])).toEqual([
    ['Mesh', 1],
    ['Mesh', 1],
  ]);
  for (const [, , positions, colors, count] of meshes) {
    const xs = [
      ...new Set(
        Array.from({ length: count }, (_, i) => positions[2 * i] ?? 0),
      ),
    ].sort((a, b) => a - b);
    // One vertex per domain unit: one per period.
    const steps = xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
    expect(steps.length).toBeGreaterThan(10);
    expect(steps.every(step => Math.abs(step - 1) < 1e-3)).toBe(true);
    // So every vertex has the same colour, one phase of the stripes, but the
    // last column's, which pdf.js evaluates half a step back.
    const last = xs.at(-1);
    const phases = new Set<string>();
    for (let i = 0; i < count; i++) {
      if (positions[2 * i] !== last)
        phases.add(Array.from(colors.subarray(4 * i, 4 * i + 3)).join());
    }
    expect(phases.size).toBe(1);
  }
});
