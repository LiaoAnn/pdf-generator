import { gtSchema } from '@pdf-generator/contract';
import { afterEach, expect, test, vi } from 'vitest';
import { checkPdf } from './index.ts';
import * as pdfReader from './pdf.ts';

afterEach(() => vi.restoreAllMocks());

test('a repetitive formula with a missing character reports a text difference in under one second', async () => {
  const text = `${'a'.repeat(209)}b`;
  const items = Array.from({ length: 20 }, (_, i) => 'a'.repeat(i + 1));
  const gt = gtSchema.parse({
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
        type: 'formula',
        page: 1,
        bbox: [50, 50, 300, 100],
        order: 0,
        text,
        latex: 'fixture',
      },
    ],
  });
  vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
    pages: [
      {
        width: 600,
        height: 800,
        marks: [],
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

  const start = performance.now();
  const report = await checkPdf(new Uint8Array(), gt);
  const elapsed = performance.now() - start;

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
  expect(elapsed).toBeLessThan(1000);
}, 60_000);
