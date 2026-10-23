import { gtSchema } from '@pdf-generator/contract';
import { expect, test, vi } from 'vitest';

test('ground-truth stub reads page sizes through string evaluation compatible with T08', async () => {
  const { readGroundTruth } = await import('./ground-truth-stub.ts');
  const source = {
    templateId: 'monthly-report',
    templateVersion: 2,
    seed: 'stub-seed',
    index: 4,
  };
  const pages = [
    { width: 595.28, height: 841.89 },
    { width: 595.28, height: 841.89 },
  ];
  const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
    expect(typeof expression).toBe('string');
    return pages;
  });
  const gt = gtSchema.parse(await readGroundTruth({ evaluate }, source));
  expect(evaluate).toHaveBeenCalled();
  expect(gt).toEqual({ schemaVersion: 1, source, pages, blocks: [] });
});
