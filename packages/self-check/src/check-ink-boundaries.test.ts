import { gtSchema } from '@pdf-generator/contract';
import { afterEach, expect, test, vi } from 'vitest';
import { type Box, checkPdf, type PdfMark, type PdfPaint } from './index.ts';
import * as pdfReader from './pdf.ts';

// Real PDFs own acceptance coverage. This seam pins sub-point geometry and
// context/spill classification without depending on Chrome's path batching.
const bbox: Box = [50, 50, 150, 90];
const gt = gtSchema.parse({
  schemaVersion: 1,
  source: {
    templateId: 'ink-boundaries',
    templateVersion: 1,
    seed: 'T14-4',
    index: 0,
  },
  pages: [{ width: 600, height: 800 }],
  blocks: [{ id: 'blank', type: 'field', page: 1, order: 0, text: '', bbox }],
});
const mark = (box: Box): PdfMark => ({ kind: 'path', box });
const context: PdfMark[] = [
  { kind: 'clip', box: [0, 0, 600, 800] },
  mark([30, 30, 170, 110]),
];
afterEach(() => vi.restoreAllMocks());

async function check(marks: PdfMark[]) {
  const paints: PdfPaint[] = marks
    .filter(mark => mark.kind !== 'clip')
    .map(({ box }) => {
      const [x0, y0, x1, y1] = box;
      return {
        box,
        polygons: [[x0, y0, x1, y0, x1, y1, x0, y1]],
        rule: 'nonzero',
        alpha: 1,
        clips: [],
        // Contrast is necessary now that visible colour, not just bounds,
        // determines ink. The enclosing context must not hide black content.
        color: box === context[1]?.box ? '#cccccc' : '#000000',
      };
    });
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
    pages: [{ width: 600, height: 800, items: [], marks, paints }],
  });
  return checkPdf(new Uint8Array(), gt);
}

test.each<{
  why: string;
  marks: PdfMark[];
  inkBox: Box;
}>([
  {
    why: '49.75% on x and less than half on y',
    marks: [mark([50, 69, 99.75, 71])],
    inkBox: [50, 69, 99.75, 71],
  },
  {
    why: '49.375% on y and less than half on x',
    marks: [mark([99, 50, 101, 69.75])],
    inkBox: [99, 50, 101, 69.75],
  },
  {
    why: 'overlapping projections sum past half but their union covers only 40%',
    marks: [mark([50, 69, 80, 71]), mark([70, 69, 90, 71])],
    inkBox: [50, 69, 90, 71],
  },
  {
    why: 'a full-box clip cannot inflate a tiny painted image',
    marks: [
      { kind: 'clip', box: bbox },
      { kind: 'image', box: [99, 69, 101, 71] },
    ],
    inkBox: [99, 69, 101, 71],
  },
  {
    why: 'the 1pt containment tolerance cannot count paint outside the box toward half',
    marks: [mark([49.25, 69, 99.25, 71])],
    inkBox: [49.25, 69, 99.25, 71],
  },
])('$why reports insufficient ink coverage', async ({ marks, inkBox }) => {
  expect(await check([...context, ...marks])).toEqual({
    ok: false,
    differences: [
      {
        kind: 'ink',
        page: 1,
        blockId: 'blank',
        bbox,
        inkBox,
        message: expect.any(String),
      },
    ],
  });
});

test.each<{ why: string; marks: PdfMark[] }>([
  {
    why: 'exactly half of x with a thin path',
    marks: [mark([50, 69, 100, 71])],
  },
  {
    why: 'exactly half of y with a narrow image',
    marks: [{ kind: 'image', box: [99, 50, 101, 70] }],
  },
  {
    why: 'disconnected projections whose union covers exactly half of x',
    marks: [mark([120, 69, 150, 71]), mark([50, 69, 70, 71])],
  },
])('$why is enough to verify a textless box', async ({ marks }) => {
  expect(await check([...context, ...marks])).toEqual({
    ok: true,
    differences: [],
  });
});

test('page clip and enclosing background alone cannot verify an invisible field', async () => {
  const result = await check(context);
  expect(result.ok).toBe(false);
  expect(result.differences).toEqual([
    {
      kind: 'ink',
      page: 1,
      blockId: 'blank',
      bbox,
      message: expect.any(String),
    },
  ]);
});

test('spill reports the union of inside and spilling ink, excluding enclosing context', async () => {
  const result = await check([
    ...context,
    mark([50, 50, 51, 90]),
    mark([140, 60, 155, 80]),
  ]);
  expect(result.ok).toBe(false);
  expect(result.differences).toEqual([
    {
      kind: 'ink',
      page: 1,
      blockId: 'blank',
      bbox,
      inkBox: [50, 50, 155, 90],
      message: expect.any(String),
    },
  ]);
});

test('a spilling clip still reports spill when a painted mark exists inside', async () => {
  const result = await check([
    mark([50, 50, 150, 90]),
    { kind: 'clip', box: [140, 60, 155, 80] },
  ]);
  expect(result).toEqual({
    ok: false,
    differences: [
      {
        kind: 'ink',
        page: 1,
        blockId: 'blank',
        bbox,
        inkBox: [50, 50, 155, 90],
        message: expect.any(String),
      },
    ],
  });
});

test.each([
  { why: '1pt edge rounding', box: [49, 89, 151, 90] as Box },
  { why: '1pt quiet-zone asymmetry', box: [57, 50, 142, 90] as Box },
  {
    why: '1.25pt quiet-zone asymmetry is only 0.625pt off centre',
    box: [57, 50, 141.75, 90] as Box,
  },
  { why: 'centred inset on both axes', box: [60, 60, 140, 80] as Box },
  {
    why: 'neighbour only touches the shrunken box edge',
    box: [149, 55, 180, 85] as Box,
  },
])('$why does not produce a false ink difference', async ({ why, box }) => {
  const marks = why.startsWith('neighbour')
    ? [mark([50, 89, 150, 90]), mark(box)]
    : [mark(box)];
  expect(await check([...context, ...marks])).toEqual({
    ok: true,
    differences: [],
  });
});

test.each([
  { why: 'edge overflow beyond 1pt', box: [48.75, 88, 150, 90] as Box },
  { why: 'vertical inset not centred', box: [50, 54, 150, 70] as Box },
])(
  '$why reports ink even with a containing section background',
  async ({ box }) => {
    const result = await check([...context, mark(box)]);
    expect(result.ok).toBe(false);
    expect(result.differences).toEqual([
      {
        kind: 'ink',
        page: 1,
        blockId: 'blank',
        bbox,
        inkBox: box,
        message: expect.any(String),
      },
    ]);
  },
);

// Quarter-point edges give exact measured bounds on measureInk's sampling
// grid. Every inset stays far from both edges; x coverage is always 80%, so
// only the centre tolerance on the named axis can decide these cases.
test.each<{ axis: string; box: Box }>([
  { axis: 'x', box: [60.75, 60, 140.75, 80] },
  { axis: 'y', box: [60, 60.75, 140, 80.75] },
])(
  '$axis centre offset of 0.75pt passes: regression for treating 1pt as a gap-difference limit',
  async ({ box }) => {
    expect(await check([...context, mark(box)])).toEqual({
      ok: true,
      differences: [],
    });
  },
);

test.each<{ axis: string; box: Box }>([
  { axis: 'x', box: [61.25, 60, 141.25, 80] },
  { axis: 'y', box: [60, 61.25, 140, 81.25] },
])(
  '$axis centre offset of 1.25pt is refused: regression for allowing centres beyond the 1pt tolerance',
  async ({ box }) => {
    expect(await check([...context, mark(box)])).toEqual({
      ok: false,
      differences: [
        {
          kind: 'ink',
          page: 1,
          blockId: 'blank',
          bbox,
          inkBox: box,
          message: expect.stringContaining("doesn't fit"),
        },
      ],
    });
  },
);

test('overflow only touching the shrunken bottom edge cannot verify the block', async () => {
  const result = await check([...context, mark([48.75, 89, 150, 90])]);
  expect(result).toStrictEqual({
    ok: false,
    differences: [
      {
        kind: 'ink',
        page: 1,
        blockId: 'blank',
        bbox,
        message: expect.any(String),
      },
    ],
  });
});
