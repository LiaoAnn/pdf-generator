import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { describe, expect, test, vi } from 'vitest';
import {
  type BuildOptions,
  buildGroundTruth,
  GroundTruthError,
  type MeasuredElement,
  type Measurement,
} from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'company-monthly-report',
  templateVersion: 3,
  seed: 'T08_demo-7',
  index: 4,
};

function element(patch: Partial<MeasuredElement> = {}): MeasuredElement {
  return {
    type: 'paragraph',
    id: null,
    ref: null,
    splitFrom: null,
    page: 0,
    region: 'area',
    rect: { x: 10, y: 20, width: 100, height: 20 },
    text: '本月營運資料',
    nested: false,
    ...patch,
  };
}

function measurement(elements: MeasuredElement[]): Measurement {
  return {
    pages: [{ x: 0, y: 0, width: 800, height: 1120 }],
    elements,
  };
}

function issues(input: Measurement, options?: BuildOptions): string[] {
  try {
    buildGroundTruth(input, source, options);
  } catch (error) {
    // Preserve unexpected errors so RED identifies the unimplemented API.
    if (!(error instanceof GroundTruthError)) throw error;
    expect(error.issues.every(issue => typeof issue === 'string')).toBe(true);
    return error.issues;
  }
  throw new Error('Expected buildGroundTruth to reject the measurement');
}

describe('buildGroundTruth', () => {
  test('builds a deterministic, contract-valid two-page report despite margin boxes preceding body in DOM order', () => {
    const input: Measurement = {
      pages: [
        { x: 100, y: 50, width: 793.6875, height: 1122.515625 },
        { x: 120, y: 1200, width: 793.6875, height: 1122.515625 },
      ],
      elements: [
        element({
          type: 'page_header',
          id: 'head',
          ref: 'header-ref',
          region: 'top',
          rect: { x: 148, y: 66, width: 400, height: 16 },
          text: ' 臺灣示範股份有限公司 ',
        }),
        element({
          type: 'page_footer',
          ref: 'footer-ref',
          region: 'bottom',
          rect: { x: 148, y: 1130, width: 400, height: 16 },
          text: '內部文件',
        }),
        element({
          type: 'title',
          rect: { x: 148, y: 130, width: 400, height: 40 },
          text: '\n 十月營運月報 \t',
        }),
        element({
          ref: 'intro',
          rect: { x: 148, y: 190, width: 600, height: 60 },
          text: ' \t營收  1,000 元\n核對完成。\n ',
        }),
        element({
          type: 'page_header',
          id: 'head',
          ref: 'header-ref',
          page: 1,
          region: 'top',
          rect: { x: 168, y: 1216, width: 400, height: 16 },
          text: '臺灣示範股份有限公司',
        }),
        element({
          type: 'page_footer',
          ref: 'footer-ref',
          page: 1,
          region: 'bottom',
          rect: { x: 168, y: 2280, width: 400, height: 16 },
          text: '內部文件',
        }),
        element({
          ref: 'intro',
          splitFrom: 'intro',
          page: 1,
          rect: { x: 168, y: 1280, width: 600, height: 40 },
          text: ' 次頁補充說明。 ',
        }),
        element({
          page: 1,
          rect: { x: 168, y: 1340, width: 600, height: 20 },
          text: '結語。',
        }),
      ],
    };
    const expected: GroundTruth = {
      schemaVersion: 1,
      source: {
        templateId: 'company-monthly-report',
        templateVersion: 3,
        seed: 'T08_demo-7',
        index: 4,
      },
      pages: [
        { width: 595.27, height: 841.89 },
        { width: 595.27, height: 841.89 },
      ],
      blocks: [
        {
          id: 'head',
          type: 'page_header',
          page: 1,
          bbox: [36, 12, 336, 24],
          order: 0,
          text: '臺灣示範股份有限公司',
        },
        {
          id: 'title-1',
          type: 'title',
          page: 1,
          bbox: [36, 60, 336, 90],
          order: 1,
          text: '十月營運月報',
        },
        {
          id: 'paragraph-1',
          type: 'paragraph',
          page: 1,
          bbox: [36, 105, 486, 150],
          order: 2,
          text: '營收  1,000 元\n核對完成。',
        },
        {
          id: 'page_footer-1',
          type: 'page_footer',
          page: 1,
          bbox: [36, 810, 336, 822],
          order: 3,
          text: '內部文件',
        },
        {
          id: 'head-2',
          type: 'page_header',
          page: 2,
          bbox: [36, 12, 336, 24],
          order: 4,
          text: '臺灣示範股份有限公司',
        },
        {
          id: 'paragraph-1-2',
          type: 'paragraph',
          page: 2,
          bbox: [36, 60, 486, 90],
          order: 5,
          text: '次頁補充說明。',
          continues: 'paragraph-1',
        },
        {
          id: 'paragraph-2',
          type: 'paragraph',
          page: 2,
          bbox: [36, 105, 486, 120],
          order: 6,
          text: '結語。',
        },
        {
          id: 'page_footer-1-2',
          type: 'page_footer',
          page: 2,
          bbox: [36, 810, 336, 822],
          order: 7,
          text: '內部文件',
        },
      ],
    };

    const result = buildGroundTruth(input, source);
    expect(result).toEqual(expected);
    expect(gtSchema.parse(result)).toEqual(expected);
    expect(buildGroundTruth(input, source)).toEqual(result);
    for (const block of result.blocks.filter(
      block => block.continues === undefined,
    )) {
      expect(block).not.toHaveProperty('continues');
    }
  });

  test('rounds absolute endpoints independently rather than adding a rounded width to a rounded origin', () => {
    const result = buildGroundTruth(
      {
        pages: [{ x: 30, y: 70, width: 793.6875, height: 1122.515625 }],
        elements: [
          element({
            rect: { x: 30.021, y: 70.021, width: 0.021, height: 0.021 },
          }),
        ],
      },
      source,
    );
    expect(result.pages).toEqual([{ width: 595.27, height: 841.89 }]);
    expect(result.blocks[0]?.bbox).toEqual([0.02, 0.02, 0.03, 0.03]);
  });

  test('orders every region before assigning auto ids and preserves DOM order instead of sorting coordinates within a region', () => {
    const result = buildGroundTruth(
      measurement([
        element({ region: 'bottom', text: 'bottom' }),
        element({ region: 'right', text: 'right' }),
        element({
          text: 'area-first',
          rect: { x: 200, y: 200, width: 100, height: 20 },
        }),
        element({ region: 'left', text: 'left' }),
        element({ region: 'top', text: 'top' }),
        element({
          text: 'area-second',
          rect: { x: 10, y: 10, width: 100, height: 20 },
        }),
      ]),
      source,
    );
    expect(
      result.blocks.map(({ id, order, text }) => ({ id, order, text })),
    ).toEqual([
      { id: 'paragraph-1', order: 0, text: 'top' },
      { id: 'paragraph-2', order: 1, text: 'left' },
      { id: 'paragraph-3', order: 2, text: 'area-first' },
      { id: 'paragraph-4', order: 3, text: 'area-second' },
      { id: 'paragraph-5', order: 4, text: 'right' },
      { id: 'paragraph-6', order: 5, text: 'bottom' },
    ]);
  });

  test('uses the latest earlier fragment and its final suffixed id when chaining splits across three pages', () => {
    const result = buildGroundTruth(
      {
        pages: [
          { x: 0, y: 0, width: 800, height: 1120 },
          { x: 0, y: 1200, width: 800, height: 1120 },
          { x: 0, y: 2400, width: 800, height: 1120 },
        ],
        elements: [
          element({
            page: 2,
            ref: 'p',
            splitFrom: 'p',
            rect: { x: 10, y: 2420, width: 100, height: 20 },
          }),
          element({ id: 'intro', ref: 'p' }),
          element({
            page: 1,
            ref: 'p',
            splitFrom: 'p',
            rect: { x: 10, y: 1220, width: 100, height: 20 },
          }),
        ],
      },
      source,
    );
    expect(
      result.blocks.map(({ id, page, continues }) => ({ id, page, continues })),
    ).toEqual([
      { id: 'intro', page: 1, continues: undefined },
      { id: 'intro-2', page: 2, continues: 'intro' },
      { id: 'intro-3', page: 3, continues: 'intro-2' },
    ]);
  });

  test('keeps an explicit fragment id while resolving continues to the origin final id', () => {
    const result = buildGroundTruth(
      {
        pages: [
          { x: 0, y: 0, width: 800, height: 1120 },
          { x: 0, y: 1200, width: 800, height: 1120 },
        ],
        elements: [
          element({ id: 'intro', ref: 'other' }),
          element({ id: 'intro', ref: 'p' }),
          element({
            id: 'continued',
            page: 1,
            splitFrom: 'p',
            rect: { x: 10, y: 1220, width: 100, height: 20 },
          }),
        ],
      },
      source,
    );
    expect(result.blocks.map(block => block.id)).toEqual([
      'intro',
      'intro-2',
      'continued',
    ]);
    expect(result.blocks[2]?.continues).toBe('intro-2');
  });

  test('merges reader-provided table, checkbox and formula details into contract-valid blocks', () => {
    const checkbox = element({ type: 'checkbox', details: { selected: true } });
    const table = {
      rows: 1,
      cols: 1,
      cells: [
        {
          row: 0,
          col: 0,
          rowSpan: 1,
          colSpan: 1,
          header: true,
          text: '金額',
          bbox: [7.5, 15, 82.5, 30],
        },
      ],
    };
    const checkboxReader = vi.fn((measured: MeasuredElement) => ({
      checked: measured.details === checkbox.details,
    }));
    const paragraphReader = vi.fn(() => ({}));
    const result = buildGroundTruth(
      measurement([
        element({ type: 'table', text: '金額' }),
        checkbox,
        element({ type: 'formula', text: '總額 = 單價 × 數量' }),
        element({ text: '附註' }),
      ]),
      source,
      {
        detailReaders: {
          table: () => ({ table }),
          checkbox: checkboxReader,
          formula: () => ({ latex: '\\mathrm{total} = p \\times q' }),
          paragraph: paragraphReader,
        },
      },
    );
    expect(result.blocks).toEqual([
      {
        id: 'table-1',
        type: 'table',
        page: 1,
        bbox: [7.5, 15, 82.5, 30],
        order: 0,
        text: '金額',
        table,
      },
      {
        id: 'checkbox-1',
        type: 'checkbox',
        page: 1,
        bbox: [7.5, 15, 82.5, 30],
        order: 1,
        text: '本月營運資料',
        checked: true,
      },
      {
        id: 'formula-1',
        type: 'formula',
        page: 1,
        bbox: [7.5, 15, 82.5, 30],
        order: 2,
        text: '總額 = 單價 × 數量',
        latex: '\\mathrm{total} = p \\times q',
      },
      {
        id: 'paragraph-1',
        type: 'paragraph',
        page: 1,
        bbox: [7.5, 15, 82.5, 30],
        order: 3,
        text: '附註',
      },
    ]);
    expect(gtSchema.parse(result)).toEqual(result);
    expect(checkboxReader).toHaveBeenCalledWith(checkbox);
    expect(paragraphReader).toHaveBeenCalledWith(
      expect.objectContaining({ text: '附註' }),
    );
  });

  test('accepts blank fields, image text and all remaining plain block types without detail readers', () => {
    const result = buildGroundTruth(
      measurement([
        element({ type: 'heading' }),
        element({ type: 'list_item' }),
        element({ type: 'label' }),
        element({ type: 'field', text: ' \t\n' }),
        element({ type: 'image', text: ' 公司章 ' }),
        element({ type: 'caption' }),
        element({ type: 'barcode' }),
        element({ type: 'page_number' }),
        element({ type: 'footnote' }),
        element({ type: 'reference' }),
      ]),
      source,
    );
    expect(result.blocks.map(({ type, text }) => [type, text])).toEqual([
      ['heading', '本月營運資料'],
      ['list_item', '本月營運資料'],
      ['label', '本月營運資料'],
      ['field', ''],
      ['image', '公司章'],
      ['caption', '本月營運資料'],
      ['barcode', '本月營運資料'],
      ['page_number', '本月營運資料'],
      ['footnote', '本月營運資料'],
      ['reference', '本月營運資料'],
    ]);
    expect(gtSchema.parse(result)).toEqual(result);
  });

  test('reports no pages as one GroundTruthError issue', () => {
    expect(issues({ pages: [], elements: [] })).toHaveLength(1);
  });

  test('collects unknown type, nesting, missing reader and unresolved split instead of stopping at the first problem', () => {
    const errors = issues(
      measurement([
        element({ type: 'unknown-widget' }),
        element({ nested: true }),
        element({ type: 'checkbox' }),
        element({ splitFrom: 'missing-origin' }),
      ]),
    );
    expect(errors).toHaveLength(4);
    expect(errors.join('\n')).toContain('unknown-widget');
    expect(errors.join('\n')).toContain('checkbox');
    expect(errors.join('\n')).toContain('missing-origin');
  });

  test.each(['table', 'checkbox', 'formula'])(
    'reports exactly one missing-reader issue naming %s',
    type => {
      const errors = issues(measurement([element({ type })]));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(type);
    },
  );

  test('does not resolve a split to a ref that appears only later in reading order', () => {
    const errors = issues(
      measurement([
        element({ region: 'top', splitFrom: 'future' }),
        element({ ref: 'future' }),
      ]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('future');
  });

  test('collects independent contract failures for zero-area and out-of-page boxes', () => {
    const errors = issues(
      measurement([
        element({ rect: { x: 10, y: 20, width: 0, height: 20 } }),
        element({ rect: { x: 790, y: 20, width: 20, height: 20 } }),
      ]),
    );
    expect(errors).toHaveLength(2);
  });

  test('rejects a generated suffix colliding with a different explicit base id', () => {
    const errors = issues(
      measurement([
        element({ id: 'foot' }),
        element({ id: 'foot' }),
        element({ id: 'foot-2' }),
      ]),
    );
    expect(errors).toHaveLength(1);
  });

  test('validates reader output rather than trusting a reader returning invalid checkbox details', () => {
    const errors = issues(measurement([element({ type: 'checkbox' })]), {
      detailReaders: { checkbox: () => ({ checked: 'true' }) },
    });
    expect(errors).toHaveLength(1);
  });

  test('validates provenance with gtSchema rather than returning an invalid source', () => {
    expect(() =>
      buildGroundTruth(measurement([]), { ...source, index: -1 }),
    ).toThrow(GroundTruthError);
  });
});
