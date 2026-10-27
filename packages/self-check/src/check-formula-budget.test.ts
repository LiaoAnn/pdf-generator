import { gtSchema } from '@pdf-generator/contract';
import { afterEach, expect, test, vi } from 'vitest';
import { checkPdf } from './index.ts';
import * as pdfReader from './pdf.ts';

afterEach(() => vi.restoreAllMocks());

// All character counts balance, but whole even-length items cannot put b at
// the odd offset 211. A character-bag shortcut must not accept this formula.
const text = `${'a'.repeat(211)}b${'a'.repeat(209)}`;
const items = [
  ...Array.from({ length: 20 }, (_, i) => 'a'.repeat((i + 1) * 2)),
  'b',
];

function fixture(type: 'formula' | 'paragraph') {
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
    pages: [
      {
        width: 600,
        height: 800,
        marks: [],
        paints: [],
        items: items.map(text => ({
          text,
          x0: 60,
          x1: 90,
          baseline: 75,
          size: 12,
          font: 'FixtureFont',
        })),
      },
    ],
  });
  return gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'formula-budget',
      templateVersion: 1,
      seed: 'T14-5',
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
}

test('an exhausted formula search fails closed with one reproducible formula_undecided difference in under one second', async () => {
  const gt = fixture('formula');
  const check = async () => {
    const start = performance.now();
    const report = await checkPdf(new Uint8Array(), gt);
    return { report, elapsed: performance.now() - start };
  };
  const first = await check();
  const second = await check();

  expect(second.report).toEqual(first.report);
  expect(first.report.ok).toBe(false);
  expect(first.report.differences).toEqual([
    {
      kind: 'formula_undecided',
      page: 1,
      blockId: 'math',
      expected: text,
      actual: items.join(''),
      message: expect.stringMatching(/formula.*match.*budget.*exceed/i),
    },
  ]);
  expect(first.elapsed).toBeLessThan(1000);
  expect(second.elapsed).toBeLessThan(1000);
}, 60_000);

test('a paragraph with the same adversarial items keeps a plain text difference', async () => {
  const report = await checkPdf(new Uint8Array(), fixture('paragraph'));

  expect(report.ok).toBe(false);
  expect(report.differences).toEqual([
    expect.objectContaining({
      kind: 'text',
      page: 1,
      blockId: 'math',
      expected: text,
      actual: items.join(''),
    }),
  ]);
});
