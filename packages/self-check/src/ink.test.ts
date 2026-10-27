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

const imagePaint = (rgba: number[], alpha = 1) =>
  paint(box, {
    color: undefined,
    alpha,
    image: {
      width: 2,
      height: 2,
      rgba: new Uint8Array(rgba),
      toImage: [0.01, 0, 0, -0.01, 0, 1],
    },
  });

test.each([true, false])(
  'an inverting transfer hides black ink through a white mask (luminosity=%s)',
  luminosity => {
    const masked = paint(box, {
      mask: {
        paints: [paint(box, { color: '#ffffff' })],
        luminosity,
        backdrop: '#000000',
        transfer: Array.from({ length: 256 }, (_, i) => 255 - i),
      },
    });
    expectNoInk(measureInk([masked], box, 0, noBackground));
  },
);

test('a white luminosity mask without a transfer preserves black ink', () => {
  const masked = paint(box, {
    mask: {
      paints: [paint(box, { color: '#ffffff' })],
      luminosity: true,
      backdrop: '#000000',
    },
  });
  expectInk(measureInk([masked], box, 0, noBackground), box, [1, 1]);
});

test.each([
  ['too short', Array(255).fill(255)],
  ['nonnumeric entry', [...Array(255).fill(255), 'invalid'] as number[]],
] as const)(
  'a %s mask transfer fails closed instead of certifying ink',
  (_name, transfer) => {
    const masked = paint(box, {
      mask: {
        paints: [paint(box, { color: '#ffffff' })],
        luminosity: true,
        backdrop: '#000000',
        transfer,
      },
    });
    const actual = measureInk([masked], box, 0, noBackground);
    expect(actual.unmeasured).toBe(true);
    expectNoInk(actual);
  },
);

test.each([
  ['transparent', Array(16).fill(0)],
  ['opaque white', Array(16).fill(255)],
] as const)('an image of %s pixels paints no ink on white', (_name, rgba) => {
  expectNoInk(measureInk([imagePaint([...rgba])], box, 0, noBackground));
});

test('one black image pixel among transparent pixels contributes only its top-right cell', () => {
  const rgba = Array(16).fill(0);
  rgba[7] = 255;
  expectInk(
    measureInk([imagePaint(rgba)], box, 0, noBackground),
    [50, 0, 100, 50],
    [0.5, 0.5],
  );
});

test.each([
  ['pixel alpha', 128, 1],
  ['paint alpha', 255, 0.5],
] as const)(
  'a half-opacity black image pixel over white still contributes ink via %s',
  (_name, pixelAlpha, paintAlpha) => {
    const rgba = Array(16).fill(0);
    rgba[7] = pixelAlpha;
    expectInk(
      measureInk([imagePaint(rgba, paintAlpha)], box, 0, noBackground),
      [50, 0, 100, 50],
      [0.5, 0.5],
    );
  },
);

const tilePaint = (paints: PdfPaint[]) =>
  paint(box, {
    color: undefined,
    tile: {
      paints,
      bbox: [0, 0, 4, 4],
      step: [4, 4],
      toPattern: [1, 0, 0, -1, 0, 100],
    },
  });

test('a tile of only white rectangles adds no ink', () => {
  expectNoInk(
    measureInk(
      [
        tilePaint([
          paint([0, 0, 4, 4], {
            color: '#ffffff',
          }),
        ]),
      ],
      box,
      0,
      noBackground,
    ),
  );
});

test('a one-by-one black tile in a four-by-four step repeats with quarter coverage on both axes', () => {
  expectInk(
    measureInk([tilePaint([paint([0, 0, 1, 1])])], box, 0, noBackground),
    [0, 3, 97, 100],
    [0.25, 0.25],
  );
});

test.each([false, true])(
  'an unmeasured paint over black hides all ink even when background=%s',
  background => {
    const tile = paint(box, { color: undefined, unmeasured: true });
    const actual = measureInk(
      background ? [tile, paint(box)] : [paint(box), tile],
      box,
      0,
      p => background && p === tile,
    );
    expectNoInk(actual);
    expect(actual.unmeasured).toBe(true);
  },
);

test('a black square beside an unmeasured paint remains ink without borrowing the unmeasured bounds', () => {
  const actual = measureInk(
    [
      paint([0, 0, 40, 100], { color: undefined, unmeasured: true }),
      paint([60, 20, 80, 40]),
    ],
    box,
    0,
    noBackground,
  );
  expectInk(actual, [60, 20, 80, 40], [0.2, 0.2]);
  expect(actual.unmeasured).toBe(true);
});

test('black drawn after an unmeasured paint cannot restore measurable ink over the unmeasured paint', () => {
  const actual = measureInk(
    [paint(box, { color: undefined, unmeasured: true }), paint(box)],
    box,
    0,
    noBackground,
  );
  expectNoInk(actual);
  expect(actual.unmeasured).toBe(true);
});

test('unmeasured paint confined to the margin still marks the measurement as unmeasured', () => {
  const actual = measureInk(
    [paint([-2, 20, -1, 22], { color: undefined, unmeasured: true })],
    box,
    2,
    noBackground,
  );
  expectNoInk(actual);
  expect(actual.unmeasured).toBe(true);
});

test('a clipped unmeasured paint hides only samples inside its clip', () => {
  const actual = measureInk(
    [
      paint(box),
      paint(box, {
        color: undefined,
        unmeasured: true,
        clips: [{ polygons: [rectangle([0, 0, 40, 100])], rule: 'nonzero' }],
      }),
    ],
    box,
    0,
    noBackground,
  );
  expectInk(actual, [40, 0, 100, 100], [0.6, 1]);
  expect(actual.unmeasured).toBe(true);
});

test.each(['absent', 'outside', 'clipped-out'] as const)(
  'unmeasured stays false when a paint is %s relative to the sampled region',
  location => {
    const tiles =
      location === 'absent'
        ? []
        : [
            paint(location === 'outside' ? [102, 0, 110, 100] : box, {
              color: undefined,
              unmeasured: true,
              clips:
                location === 'clipped-out'
                  ? [
                      {
                        polygons: [rectangle([102, 0, 110, 100])],
                        rule: 'nonzero',
                      },
                    ]
                  : [],
            }),
          ];
    const actual = measureInk(
      [...tiles, paint([60, 20, 80, 40])],
      box,
      1,
      noBackground,
    );
    expectInk(actual, [60, 20, 80, 40], [0.2, 0.2]);
    expect(actual.unmeasured).toBe(false);
  },
);

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

test('decoded black image pixels contrast with decoded red background pixels', () => {
  const background = imagePaint([
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  expectInk(
    measureInk(
      [
        background,
        imagePaint([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
      ],
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
    name: 'decoded opaque black image pixels cannot be discarded as white',
    paints: [
      imagePaint([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
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
