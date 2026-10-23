import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import {
  type BlockList,
  blockListSchema,
  contractSchemas,
  type ListedBlock,
} from './index.ts';

function example(kind: 'valid' | 'invalid'): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../examples/block-list.${kind}.json`, import.meta.url),
      'utf8',
    ),
  );
}

function document(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    source: {
      file: ' 掃描報表.pdf ',
      tool: { name: 'mineru', version: '2.5.4' },
    },
    pages: [{ width: 595.28, height: 841.89 }],
    blocks: [
      {
        id: 'b0',
        type: 'paragraph',
        page: 1,
        bbox: [0, 0, 100, 20],
        order: 0,
        text: ' 原文 ',
        ...patch,
      },
    ],
  };
}

describe('block lists imported from Mac PDF tooling', () => {
  test('registers the decoder so export compatibility tests reach block-list consumers', () => {
    expect(contractSchemas).toHaveProperty('block-list', blockListSchema);
  });

  test('preserves MinerU output and public types without normalizing extracted text or HTML', () => {
    const value = example('valid');
    expect(blockListSchema.parse(value)).toEqual(value);
    expectTypeOf<BlockList>().toEqualTypeOf<z.infer<typeof blockListSchema>>();
    expectTypeOf<BlockList['blocks'][number]>().toEqualTypeOf<ListedBlock>();
  });

  test('invalid example differs only by confidence above one', () => {
    const valid = example('valid') as BlockList;
    const invalid = structuredClone(valid);
    Object.assign(invalid.blocks[0] ?? {}, { confidence: 1.01 });
    expect(example('invalid')).toEqual(invalid);
    const result = blockListSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map(issue => issue.path)).toEqual([
        ['blocks', 0, 'confidence'],
      ]);
  });

  test.each(['table', 'formula', 'checkbox', 'paragraph'])(
    'accepts %s without gt-only required details and permits optional extraction metadata on any type',
    type => {
      for (const patch of [
        { type },
        {
          type,
          confidence: 0,
          latex: '',
          checked: false,
          html: ' <table></table> ',
        },
        { type, confidence: 1 },
      ]) {
        const value = document(patch);
        expect(blockListSchema.parse(value)).toEqual(value);
      }
    },
  );

  test.each([
    { confidence: -0.01 },
    { confidence: 1.01 },
    { confidence: '0.5' },
    { latex: null },
    { checked: 'false' },
    { html: 1 },
    { continues: 'b1' },
    { table: { rows: 1, cols: 1, cells: [] } },
  ])('rejects invalid extraction metadata or gt-only fields: %j', patch => {
    expect(blockListSchema.safeParse(document(patch)).success).toBe(false);
  });

  test.each([
    { file: '' },
    { file: 'a'.repeat(256) },
    { file: 1 },
    { typo: true },
    { tool: { name: '', version: '2.5.4' } },
    { tool: { name: 'mineru', version: '' } },
    { tool: { name: 'mineru' } },
    { tool: { name: 'mineru', version: '2.5.4', typo: true } },
  ])(
    'rejects missing, oversized or misspelled extraction provenance: %j',
    patch => {
      const value = document();
      Object.assign(value.source, patch);
      expect(blockListSchema.safeParse(value).success).toBe(false);
    },
  );

  test('preserves maximum-length file names and absent extraction metadata', () => {
    const value = document();
    value.source.file = 'a'.repeat(255);
    expect(blockListSchema.parse(value)).toEqual(value);
  });
});
