import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { afterEach, expect, test, vi } from 'vitest';
import { checkPdf } from './index.ts';
import * as pdfReader from './pdf.ts';

afterEach(() => vi.restoreAllMocks());

// Chromium can merge or split these runs depending on the font version.
// This seam fixes item boundaries to distinguish whole-item permutations
// from a character bag, and forces the ambiguous "t"/"tanh" assignment.
async function compare(
  text: string,
  items: string[],
  {
    type = 'formula',
    spill = false,
  }: { type?: 'formula' | 'paragraph'; spill?: boolean } = {},
) {
  const gt: GroundTruth = gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'formula-items',
      templateVersion: 1,
      seed: 'T14-3',
      index: 0,
    },
    pages: [{ width: 600, height: 800 }],
    blocks: [
      {
        id: 'math',
        type,
        page: 1,
        bbox: [50, 50, 300, 100],
        order: 0,
        text,
        ...(type === 'formula' ? { latex: 'fixture' } : {}),
      },
    ],
  });
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
    pages: [
      {
        width: 600,
        height: 800,
        marks: [],
        paints: [],
        items: items.map(text => ({
          text,
          x0: spill ? 40 : 60,
          x1: 90,
          baseline: 75,
          size: 12,
          font: 'FixtureFont',
        })),
      },
    ],
  });
  return checkPdf(new Uint8Array(), gt);
}

test.each([
  {
    why: 'ambiguous short and long items require a complete non-overlapping cover',
    text: 'ht=tanh',
    items: ['h', '=', 't', 'tanh'],
  },
  {
    why: 'whole items may be swapped (the documented blind spot)',
    text: 'cdab',
    items: ['ab', 'cd'],
  },
  {
    why: 'a short item cannot greedily consume characters needed by a longer item',
    text: 'tanh=ht',
    items: ['h', '=', 't', 'tanh'],
  },
  {
    why: 'duplicate items must each consume their own occurrence',
    text: 'tt=h',
    items: ['h', '=', 't', 't'],
  },
  {
    why: 'item normalization retains NFKC, whitespace and case folding',
    text: 'fi=h',
    items: ['Ｈ', ' = ', 'ﬁ'],
  },
  {
    why: 'old gt may contain KaTeX zero-width struts',
    text: 'h\u200bt=tanh\u200b',
    items: ['h', '=', 't', 'tanh'],
  },
])('formula accepts $why', async ({ text, items }) => {
  expect(await compare(text, items)).toEqual({ ok: true, differences: [] });
});

test.each([
  { why: 'changed character', text: 'hz=tanh', items: ['h', '=', 't', 'tanh'] },
  { why: 'missing character', text: 'h=tanh', items: ['h', '=', 't', 'tanh'] },
  { why: 'extra character', text: 'htt=tanh', items: ['h', '=', 't', 'tanh'] },
  {
    why: 'characters reordered inside a word item',
    text: 'ht=tnah',
    items: ['h', '=', 't', 'tanh'],
  },
  {
    why: 'characters reordered inside a signed-number item',
    text: 'x=1−',
    items: ['x', '=', '−1'],
  },
  {
    why: 'overlapping substring matches cannot reuse gt characters',
    text: 'abcab',
    items: ['abc', 'bc'],
  },
  {
    why: 'one repeated item cannot cover two occurrences',
    text: 'tt=h',
    items: ['h', '=', 't'],
  },
])('formula rejects $why', async ({ text, items }) => {
  const report = await compare(text, items);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'text',
      blockId: 'math',
      expected: text,
      actual: items.join(''),
    }),
  ]);
});

test('a paragraph cannot use the formula whole-item permutation exception', async () => {
  const report = await compare('ht=tanh', ['h', '=', 't', 'tanh'], {
    type: 'paragraph',
  });
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({ kind: 'text', blockId: 'math' }),
  ]);
});

test('a formula that matches by item permutation still reports text spilling outside its box', async () => {
  const report = await compare('cdab', ['ab', 'cd'], { spill: true });
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'bbox',
      blockId: 'math',
      bbox: [50, 50, 300, 100],
      textBox: [40, 66.6, 90, 75],
    }),
  ]);
});

test('a text-free formula still needs painted ink to verify its box', async () => {
  const report = await compare('', []);
  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'ink',
      blockId: 'math',
      bbox: [50, 50, 300, 100],
    }),
  ]);
});
