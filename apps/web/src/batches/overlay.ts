// Geometry and colours for drawing gt.json blocks over a printed page.
import {
  type BlockType,
  blockTypes,
  type GtBlock,
} from '@pdf-generator/contract';

/**
 * A bbox ([x0, y0, x1, y1] in PDF points from the page's top-left corner) as
 * percentages of its page, so the box scales with the page drawn under it.
 */
export function boxPercent(
  [x0, y0, x1, y1]: readonly [number, number, number, number],
  page: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: (x0 / page.width) * 100,
    top: (y0 / page.height) * 100,
    width: ((x1 - x0) / page.width) * 100,
    height: ((y1 - y0) / page.height) * 100,
  };
}

// One colour per block type, in blockTypes order.
const colors: Record<BlockType, string> = {
  title: '#dc2626',
  heading: '#ea580c',
  paragraph: '#2563eb',
  list_item: '#0891b2',
  label: '#ca8a04',
  field: '#16a34a',
  table: '#9333ea',
  image: '#db2777',
  caption: '#65a30d',
  formula: '#0d9488',
  checkbox: '#4f46e5',
  barcode: '#57534e',
  page_header: '#64748b',
  page_footer: '#475569',
  page_number: '#a16207',
  footnote: '#be123c',
  reference: '#7c3aed',
};

/** The colour of a block type's boxes and legend entry. */
export function typeColor(type: BlockType): string {
  return colors[type];
}

/** The block types present, with their block counts, in blockTypes order. */
export function typeCounts(
  blocks: readonly GtBlock[],
): { type: BlockType; count: number }[] {
  const counts = new Map<BlockType, number>();
  for (const block of blocks) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  }
  return blockTypes.flatMap(type => {
    const count = counts.get(type);
    return count === undefined ? [] : [{ type, count }];
  });
}
