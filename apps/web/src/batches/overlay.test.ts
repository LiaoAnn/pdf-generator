import { blockTypes, gtSchema } from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { boxPercent, typeColor, typeCounts } from './overlay';

const gt = gtSchema.parse(gtExample);

describe('boxPercent', () => {
  it('keeps the top-left origin and measures each axis against its own page dimension', () => {
    expect(boxPercent([20, 120, 80, 200], { width: 200, height: 400 })).toEqual(
      {
        left: 10,
        top: 30,
        width: 30,
        height: 20,
      },
    );
    expect(boxPercent([20, 120, 80, 200], { width: 400, height: 200 })).toEqual(
      {
        left: 5,
        top: 60,
        width: 15,
        height: 40,
      },
    );
  });

  it('preserves fractional A4 coordinates rather than rounding boxes away from printed content', () => {
    const block = gt.blocks[0];
    const page = gt.pages[0];
    if (!block || !page) throw new Error('Contract fixture has no first page');
    const box = boxPercent(block.bbox, page);
    expect(box.left).toBeCloseTo(6.047574250772746, 10);
    expect(box.top).toBeCloseTo(4.276093076292628, 10);
    expect(box.width).toBeCloseTo(87.8578148098374, 10);
    expect(box.height).toBeCloseTo(3.563410896910523, 10);
  });
});

describe('typeColor', () => {
  it('does not give two block types the same colour or leave a type colourless', () => {
    const colours = blockTypes.map(type => typeColor(type));
    for (const colour of colours) expect(colour.trim()).not.toBe('');
    expect(
      new Set(colours.map(colour => colour.trim().toLowerCase())).size,
    ).toBe(blockTypes.length);
  });
});

describe('typeCounts', () => {
  it('counts repeated types across pages and orders the legend by contract order rather than encounter order', () => {
    const blocks = Object.freeze([...gt.blocks].reverse());
    expect(typeCounts(blocks)).toEqual([
      { type: 'title', count: 1 },
      { type: 'paragraph', count: 1 },
      { type: 'field', count: 1 },
      { type: 'table', count: 2 },
      { type: 'image', count: 1 },
      { type: 'formula', count: 1 },
      { type: 'checkbox', count: 1 },
      { type: 'page_number', count: 2 },
    ]);
  });

  it('does not populate an empty legend with zero-count types', () => {
    expect(typeCounts([])).toEqual([]);
  });
});
