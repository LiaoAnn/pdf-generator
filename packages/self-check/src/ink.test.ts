import { expect, test } from 'vitest';
import type { Box } from './check.ts';
import { type Ink, measureInk } from './ink.ts';
import type { PdfPaint, PdfShading } from './pdf.ts';

const box: Box = [0, 0, 100, 100];
const noBackground = () => false;
const rectangle = ([x0, y0, x1, y1]: Box): number[] => [
  x0,
  y0,
  x1,
  y0,
  x1,
  y1,
  x0,
  y1,
];
const paint = (bounds: Box, overrides: Partial<PdfPaint> = {}): PdfPaint => ({
  box: bounds,
  polygons: [rectangle(bounds)],
  rule: 'nonzero',
  color: '#000000',
  alpha: 1,
  clips: [],
  ...overrides,
});

const axial = (start: string, end: string): PdfShading => ({
  kind: 'axial',
  stops: [
    [0, start],
    [1, end],
  ],
  from: [0, 0],
  to: [100, 0],
  r0: 0,
  r1: 0,
  toShading: [1, 0, 0, 1, 0, 0],
});

test('group opacity composites black then white together before blending onto white', () => {
  const groups = [{ id: 1, alpha: 0.5 }];
  expectNoInk(
    measureInk(
      [paint(box, { groups }), paint(box, { groups, color: '#ffffff' })],
      box,
      0,
      noBackground,
    ),
  );
});

test('a half-opacity group containing only black still leaves ink', () => {
  expectInk(
    measureInk(
      [paint(box, { groups: [{ id: 1, alpha: 0.5 }] })],
      box,
      0,
      noBackground,
    ),
    box,
    [1, 1],
  );
});

test('nested half-opacity groups blend black at one quarter opacity rather than one half', () => {
  const background = paint(box, { color: '#bfbfbf' });
  // Black at 0.5 × 0.5 over white rounds to 191 in every channel.
  const paints = [
    background,
    paint(box, { color: '#ffffff' }),
    paint(box, {
      groups: [
        { id: 1, alpha: 0.5 },
        { id: 2, alpha: 0.5 },
      ],
    }),
  ];
  expectNoInk(measureInk(paints, box, 0, p => p === background));
});

test('a white-to-white axial gradient leaves no ink on white', () => {
  expectNoInk(
    measureInk(
      [paint(box, { color: undefined, shading: axial('#ffffff', '#ffffff') })],
      box,
      0,
      noBackground,
    ),
  );
});

test('an axial gradient counts only its left-half painted samples beyond colour rounding', () => {
  const actual = measureInk(
    [
      paint([0, 0, 50, 100], {
        color: undefined,
        shading: axial('#ffffff', '#000000'),
      }),
    ],
    box,
    0,
    noBackground,
  );
  expect(actual.box).toBeDefined();
  expect(actual.box?.[0]).toBeGreaterThanOrEqual(0.25);
  expect(actual.box?.[0]).toBeLessThan(1.5);
  expect(actual.coverage[0]).toBeGreaterThan(0.48);
  expect(actual.coverage[0]).toBeLessThan(0.5);
  expect(actual.coverage[1]).toBe(1);
});

test('a solid matching its gradient background leaves no ink after background subtraction', () => {
  const background = paint(box, {
    color: undefined,
    shading: axial('#123456', '#123456'),
  });
  expectNoInk(
    measureInk(
      [background, paint(box, { color: '#123456' })],
      box,
      0,
      p => p === background,
    ),
  );
});

test('different unknown-colour paints cannot cancel foreground ink against its background', () => {
  const background = paint(box, { color: undefined });
  expectInk(
    measureInk(
      [background, paint(box, { color: undefined })],
      box,
      0,
      p => p === background,
    ),
    box,
    [1, 1],
  );
});

function expectInk(
  actual: Ink,
  expectedBox: Box,
  coverage: [number, number],
  measuredBox: Box = box,
) {
  expect(actual.box, 'visible ink must have bounds').toBeDefined();
  if (!actual.box) return;
  for (const axis of [0, 1, 2, 3] as const) {
    expect(Math.abs(actual.box[axis] - expectedBox[axis])).toBeLessThanOrEqual(
      0.3,
    );
  }
  for (const axis of [0, 1] as const) {
    const size =
      axis === 0
        ? measuredBox[2] - measuredBox[0]
        : measuredBox[3] - measuredBox[1];
    expect(
      Math.abs(actual.coverage[axis] - coverage[axis]),
    ).toBeLessThanOrEqual(0.3 / size);
  }
}

function expectNoInk(actual: Ink, measuredBox: Box = box) {
  expect(actual.box).toBeUndefined();
  for (const axis of [0, 1] as const) {
    const size =
      axis === 0
        ? measuredBox[2] - measuredBox[0]
        : measuredBox[3] - measuredBox[1];
    expect(Math.abs(actual.coverage[axis])).toBeLessThanOrEqual(0.3 / size);
  }
}

test('disconnected corner squares cannot inflate coverage to their bounding rectangle', () => {
  const squares: PdfPaint = paint(box, {
    polygons: [rectangle([0, 0, 1, 1]), rectangle([99, 99, 100, 100])],
  });
  expectInk(measureInk([squares], box, 0, noBackground), box, [0.02, 0.02]);
});

test('overlapping projections count once even for separate paints', () => {
  expectInk(
    measureInk(
      [paint([10, 10, 40, 40]), paint([30, 30, 50, 50])],
      box,
      0,
      noBackground,
    ),
    [10, 10, 50, 50],
    [0.4, 0.4],
  );
});

test('duplicate even-odd subpaths cancel instead of painting their bounding rectangle', () => {
  expectNoInk(
    measureInk(
      [
        paint(box, {
          polygons: [rectangle(box), rectangle(box)],
          rule: 'evenodd',
        }),
      ],
      box,
      0,
      noBackground,
    ),
  );
});

test('duplicate same-winding nonzero subpaths remain filled instead of cancelling', () => {
  expectInk(
    measureInk(
      [paint(box, { polygons: [rectangle(box), rectangle(box)] })],
      box,
      0,
      noBackground,
    ),
    box,
    [1, 1],
  );
});

test.each<{ name: string; paints: PdfPaint[] }>([
  {
    name: 'white on a white page is not ink',
    paints: [paint(box, { color: '#ffffff' })],
  },
  {
    name: 'opaque white overpaint erases earlier black ink',
    paints: [paint(box), paint(box, { color: '#ffffff' })],
  },
  { name: 'alpha zero cannot leave ink', paints: [paint(box, { alpha: 0 })] },
  {
    name: 'an empty even-odd clip rejects the full-box paint',
    paints: [
      paint(box, {
        clips: [
          { polygons: [rectangle(box), rectangle(box)], rule: 'evenodd' },
        ],
      }),
    ],
  },
])('$name', ({ paints }) => {
  expectNoInk(measureInk(paints, box, 0, noBackground));
});

test.each<{ name: string; paints: PdfPaint[] }>([
  {
    name: 'black after white remains ink so paint order cannot be reversed',
    paints: [paint(box, { color: '#ffffff' }), paint(box)],
  },
  {
    name: 'half-opacity black still differs from the white page',
    paints: [paint(box, { alpha: 0.5 })],
  },
  {
    name: 'light grey is ink without a darkness threshold',
    paints: [paint(box, { color: '#f0f0f0' })],
  },
  {
    name: 'an image with unknown colour cannot be discarded as white-ish',
    paints: [
      { box, polygons: [rectangle(box)], rule: 'nonzero', alpha: 1, clips: [] },
    ],
  },
])('$name', ({ paints }) => {
  expectInk(measureInk(paints, box, 0, noBackground), box, [1, 1]);
});

test('a nonzero left-half clip limits coverage instead of only filtering paint bounds', () => {
  expectInk(
    measureInk(
      [
        paint(box, {
          clips: [{ polygons: [rectangle([0, 0, 50, 100])], rule: 'nonzero' }],
        }),
      ],
      box,
      0,
      noBackground,
    ),
    [0, 0, 50, 100],
    [0.5, 1],
  );
});

test('every clip must contain ink rather than combining clips as a union', () => {
  expectInk(
    measureInk(
      [
        paint(box, {
          clips: [
            { polygons: [rectangle([0, 0, 50, 100])], rule: 'nonzero' },
            { polygons: [rectangle([0, 0, 100, 25])], rule: 'evenodd' },
          ],
        }),
      ],
      box,
      0,
      noBackground,
    ),
    [0, 0, 50, 25],
    [0.5, 0.25],
  );
});

test('background subtraction leaves only the small foreground square', () => {
  const background = paint([-100, -100, 200, 200], { color: '#808080' });
  expectInk(
    measureInk(
      [background, paint([20, 30, 22, 32])],
      box,
      0,
      p => p === background,
    ),
    [20, 30, 22, 32],
    [0.02, 0.02],
  );
});

test('a large grey rect is not implicitly background when the predicate rejects it', () => {
  expectInk(
    measureInk(
      [
        paint([-100, -100, 200, 200], { color: '#808080' }),
        paint([20, 30, 22, 32]),
      ],
      box,
      0,
      noBackground,
    ),
    box,
    [1, 1],
  );
});

test('same-colour foreground over background is invisible even with partial alpha', () => {
  const background = paint(box, { color: '#808080' });
  expectNoInk(
    measureInk(
      [background, paint(box, { color: '#808080', alpha: 0.5 })],
      box,
      0,
      p => p === background,
    ),
  );
});

test('source-over blending can match the background instead of always counting translucent paint', () => {
  const background = paint(box, { color: '#808080' });
  // 50% white over #010101 is exactly #808080 in every channel.
  expectNoInk(
    measureInk(
      [
        background,
        paint(box, { color: '#010101' }),
        paint(box, { color: '#ffffff', alpha: 0.5 }),
      ],
      box,
      0,
      p => p === background,
    ),
  );
});

test('margin-only ink contributes bounds but cannot inflate either coverage axis', () => {
  expectInk(
    measureInk([paint([-3, 20, -1, 22])], box, 2, noBackground),
    [-2, 20, -1, 22],
    [0, 0],
  );
});

test('opposite-winding nonzero subpaths leave a real hole rather than filling the bounds', () => {
  const ring = paint(box, {
    polygons: [rectangle(box), [20, 20, 20, 80, 80, 80, 80, 20]],
  });
  expectInk(measureInk([ring], box, 0, noBackground), box, [1, 1]);
  const hole: Box = [30, 30, 70, 70];
  expectNoInk(measureInk([ring], hole, 0, noBackground), hole);
});

test('a one-point dot in a 600 by 800 box retains quarter-point precision', () => {
  const largeBox: Box = [0, 0, 600, 800];
  const dot: Box = [321.25, 456.5, 322.25, 457.5];
  expectInk(
    measureInk([paint(dot)], largeBox, 0, noBackground),
    dot,
    [1 / 600, 1 / 800],
    largeBox,
  );
});
