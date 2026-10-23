import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import {
  type BlockType,
  bboxSchema,
  blockListSchema,
  type blockTypes,
  contractSchemas,
  type GroundTruth,
  type GtBlock,
  gtSchema,
  seedSchema,
} from './index.ts';

function example(kind: 'valid' | 'invalid'): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../examples/gt.${kind}.json`, import.meta.url),
      'utf8',
    ),
  );
}

function block(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'block_A-1',
    type: 'paragraph',
    page: 1,
    bbox: [0, 0, 100, 20],
    order: 0,
    text: ' 原文 ',
    ...patch,
  };
}

function document(blocks = [block()]) {
  return {
    schemaVersion: 1,
    source: {
      templateId: 'monthly-report',
      templateVersion: 1,
      seed: 'Seed_01-a',
      index: 0,
    },
    pages: [
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
    ],
    blocks,
  };
}

function issuePaths(
  schema: typeof gtSchema | typeof blockListSchema,
  input: unknown,
) {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map(issue => issue.path);
}

describe('shared PDF coordinates and portable seeds', () => {
  test.each([
    [0, 0, 595.28, 841.89],
    [0.25, 1.5, 2.75, 3.5],
  ])(
    'preserves fractional PDF points and top-left zero coordinates: %j',
    (...box) => {
      expect(bboxSchema.parse(box)).toEqual(box);
    },
  );

  test.each([
    [0, 0, 1],
    [0, 0, 1, 1, 2],
    [-1, 0, 1, 1],
    [0, -1, 1, 1],
    [0, 0, -1, 1],
    [0, 0, 1, -1],
    ['0', 0, 1, 1],
    [0, 0, Infinity, 1],
    [0, 0, 1, NaN],
  ])('rejects malformed, negative or nonfinite bbox %j', (...box) => {
    expect(bboxSchema.safeParse(box).success).toBe(false);
  });

  test.each([
    [1, 0, 1, 2],
    [2, 0, 1, 2],
    [0, 1, 2, 1],
    [0, 2, 2, 1],
  ])('reports zero-area or reversed bbox %j on the bbox itself', (...box) => {
    const result = bboxSchema.safeParse(box);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map(issue => issue.path)).toContainEqual([]);
  });

  test.each(['a', 'A0_-', 'a'.repeat(64)])(
    'preserves portable seed %j',
    seed => {
      expect(seedSchema.parse(seed)).toBe(seed);
    },
  );
  test.each(['', 'a'.repeat(65), 'a b', 'a/b', '種子', 'seed\n', 1])(
    'rejects seed %j that cannot round-trip as a portable identifier',
    seed => {
      expect(seedSchema.safeParse(seed).success).toBe(false);
    },
  );
});

// Exercise shared invariants through both public decoders without duplicating cases.
for (const name of ['gt', 'block-list'] as const) {
  const schema = name === 'gt' ? gtSchema : blockListSchema;
  function input(blocks = [block()]) {
    const common = document(blocks);
    return name === 'gt'
      ? common
      : {
          ...common,
          source: {
            file: '原始報表.pdf',
            tool: { name: 'mineru', version: '2.5.4' },
          },
        };
  }

  describe(`${name}: shared document invariants`, () => {
    test('preserves blank text, absent optionals and empty documents without defaults', () => {
      for (const value of [input([]), input([block({ text: '' })])])
        expect(schema.parse(value)).toEqual(value);
    });

    test.each([
      ['version', { schemaVersion: 2 }],
      ['coerced version', { schemaVersion: '1' }],
      ['no pages', { pages: [] }],
      ['zero width', { pages: [{ width: 0, height: 1 }] }],
      ['negative height', { pages: [{ width: 1, height: -1 }] }],
      ['coerced dimension', { pages: [{ width: '1', height: 1 }] }],
      ['unknown root key', { typo: true }],
      ['unknown page key', { pages: [{ width: 1, height: 1, typo: true }] }],
    ])('rejects %s before geometry reaches a consumer', (_label, patch) => {
      expect(schema.safeParse({ ...input(), ...patch }).success).toBe(false);
    });

    test.each([
      { id: '' },
      { id: 'a'.repeat(65) },
      { id: 'a b' },
      { id: '區塊' },
      { page: 0 },
      { page: 1.5 },
      { page: '1' },
      { order: -1 },
      { order: 0.5 },
      { text: null },
      { type: 'unknown' },
      { typo: true },
    ])('rejects malformed block identity or scalar fields: %j', patch => {
      expect(schema.safeParse(input([block(patch)])).success).toBe(false);
    });

    test('accepts document-wide shuffled reading order and boxes on page edges', () => {
      const value = input([
        block({ order: 1, bbox: [0, 0, 595.28, 841.89] }),
        block({ id: 'next', page: 2, order: 0 }),
      ]);
      expect(schema.parse(value)).toEqual(value);
    });

    test('reports duplicate identity on the later block', () => {
      expect(
        issuePaths(schema, input([block(), block({ order: 1 })])),
      ).toContainEqual(['blocks', 1, 'id']);
    });

    test.each([0, 2])(
      'reports repeated or out-of-range order %j on the offending block',
      order => {
        expect(
          issuePaths(schema, input([block(), block({ id: 'next', order })])),
        ).toContainEqual(['blocks', 1, 'order']);
      },
    );

    test('reports a nonexistent page without attempting to read its dimensions', () => {
      const paths = issuePaths(
        schema,
        input([block({ page: 3, bbox: [0, 0, 999, 999] })]),
      );
      expect(paths).toContainEqual(['blocks', 0, 'page']);
      expect(paths).not.toContainEqual(['blocks', 0, 'bbox']);
    });

    test.each([
      [0, 0, 595.29, 20],
      [0, 0, 100, 841.9],
    ])('reports bbox %j that exceeds the referenced page', (...bbox) => {
      expect(issuePaths(schema, input([block({ bbox })]))).toContainEqual([
        'blocks',
        0,
        'bbox',
      ]);
    });

    test('uses the referenced page dimensions rather than the first page', () => {
      const value = input([block({ page: 2, bbox: [0, 0, 101, 20] })]);
      value.pages[1] = { width: 100, height: 100 };
      expect(issuePaths(schema, value)).toContainEqual(['blocks', 0, 'bbox']);
    });
  });
}

describe('ground truth for printed PDF fixtures', () => {
  test('registers the runtime decoder so export compatibility tests reach gt consumers', () => {
    expect(contractSchemas).toHaveProperty('gt', gtSchema);
  });

  test('preserves multipage tables, repeated headers, blank fields and image text', () => {
    const value = example('valid');
    expect(gtSchema.parse(value)).toEqual(value);
    expectTypeOf<GroundTruth>().toEqualTypeOf<z.infer<typeof gtSchema>>();
    expectTypeOf<GroundTruth['blocks'][number]>().toEqualTypeOf<GtBlock>();
    expectTypeOf<GtBlock['type']>().toEqualTypeOf<BlockType>();
    expectTypeOf<(typeof blockTypes)[number]>().toEqualTypeOf<BlockType>();
  });

  test('invalid example has exactly the missing checkbox state defect', () => {
    const valid = example('valid') as GroundTruth;
    const invalid = structuredClone(valid);
    const checkbox = invalid.blocks.find(item => item.type === 'checkbox');
    expect(checkbox).toBeDefined();
    if (checkbox) Reflect.deleteProperty(checkbox, 'checked');
    expect(example('invalid')).toEqual(invalid);
    expect(issuePaths(gtSchema, invalid)).toEqual([
      [
        'blocks',
        valid.blocks.findIndex(item => item.type === 'checkbox'),
        'checked',
      ],
    ]);
  });

  test.each([
    { templateId: 'Bad_ID' },
    { templateVersion: 0 },
    { templateVersion: 1.5 },
    { seed: 'bad seed' },
    { index: -1 },
    { index: 0.5 },
    { typo: true },
  ])('rejects invalid fixture provenance: %j', patch => {
    const value = document();
    Object.assign(value.source, patch);
    expect(gtSchema.safeParse(value).success).toBe(false);
  });

  test.each([
    'title',
    'heading',
    'paragraph',
    'list_item',
    'label',
    'field',
    'image',
    'caption',
    'barcode',
    'page_header',
    'page_footer',
    'page_number',
    'footnote',
    'reference',
  ])(
    'accepts plain %s blocks but rejects detail keys belonging to another variant',
    type => {
      const value = document([block({ type })]);
      expect(gtSchema.parse(value)).toEqual(value);
      for (const detail of [
        { checked: false },
        { latex: 'x' },
        { table: { rows: 1, cols: 1, cells: [] } },
      ]) {
        expect(
          gtSchema.safeParse(document([block({ type, ...detail })])).success,
        ).toBe(false);
      }
    },
  );

  test.each([
    { type: 'table' },
    { type: 'checkbox' },
    { type: 'checkbox', checked: 'false' },
    { type: 'formula' },
    { type: 'formula', latex: '' },
    { type: 'checkbox', checked: false, latex: 'x' },
  ])('rejects missing or misplaced variant details: %j', patch => {
    expect(gtSchema.safeParse(document([block(patch)])).success).toBe(false);
  });

  test('resolves continuation by id even if its earlier-page target appears later in the array', () => {
    const value = document([
      block({ id: 'second', page: 2, continues: 'first' }),
      block({ id: 'first', order: 1 }),
    ]);
    expect(gtSchema.parse(value)).toEqual(value);
  });

  test.each([
    ['missing', { continues: 'missing' }],
    ['self', { continues: 'block_A-1' }],
    ['same page', { continues: 'target' }],
    ['later page', { continues: 'target', page: 1 }],
    ['different type', { continues: 'target', page: 2, type: 'title' }],
    ['malformed id', { continues: 'bad id', page: 2 }],
  ])('rejects %s continuation at its reference', (label, patch) => {
    const target = block({
      id: 'target',
      order: 1,
      page: label === 'later page' ? 2 : 1,
    });
    expect(
      issuePaths(gtSchema, document([block(patch), target])),
    ).toContainEqual(['blocks', 0, 'continues']);
  });
});

function tableDocument(
  tablePatch: Record<string, unknown> = {},
  cellPatch: Record<string, unknown> = {},
) {
  return document([
    block({
      type: 'table',
      table: {
        rows: 2,
        cols: 2,
        cells: [
          {
            row: 0,
            col: 0,
            rowSpan: 2,
            colSpan: 2,
            header: false,
            text: '',
            bbox: [0, 0, 100, 20],
            ...cellPatch,
          },
        ],
        ...tablePatch,
      },
    }),
  ]);
}

describe('ground truth table fragments', () => {
  test('accepts cell spans ending exactly at grid boundaries and empty cell arrays', () => {
    for (const value of [tableDocument(), tableDocument({ cells: [] })])
      expect(gtSchema.parse(value)).toEqual(value);
  });

  test.each([{ row: 1 }, { col: 1 }, { rowSpan: 3 }, { colSpan: 3 }])(
    'reports overflowing cell span %j on the cell',
    patch => {
      expect(issuePaths(gtSchema, tableDocument({}, patch))).toContainEqual([
        'blocks',
        0,
        'table',
        'cells',
        0,
      ]);
    },
  );

  test.each([
    { rows: 0 },
    { cols: 0 },
    { rows: 1.5 },
    { cols: 1.5 },
    { typo: true },
  ])('rejects invalid or silently discarded table grid metadata: %j', patch => {
    expect(gtSchema.safeParse(tableDocument(patch)).success).toBe(false);
  });

  test.each([
    { row: -1 },
    { col: -1 },
    { row: 0.5 },
    { col: 0.5 },
    { rowSpan: 0 },
    { colSpan: 0 },
    { rowSpan: 1.5 },
    { colSpan: 1.5 },
    { header: 'false' },
    { text: null },
    { bbox: [0, 0, 1] },
    { typo: true },
  ])('rejects malformed cell metadata: %j', patch => {
    expect(gtSchema.safeParse(tableDocument({}, patch)).success).toBe(false);
  });
});
