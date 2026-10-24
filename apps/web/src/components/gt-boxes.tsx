import type { BlockType, GtBlock } from '@pdf-generator/contract';
import { boxPercent, typeColor } from '../batches/overlay';

/**
 * The gt.json blocks of one page as boxes over that page, coloured by type.
 * Positions are percentages of the gt page size, so the parent only has to
 * cover the drawn page exactly.
 */
export function GtBoxes({
  blocks,
  page,
  size,
  hidden,
}: {
  blocks: readonly GtBlock[];
  page: number;
  size: { width: number; height: number };
  hidden: ReadonlySet<BlockType>;
}) {
  return blocks
    .filter(block => block.page === page && !hidden.has(block.type))
    .map(block => {
      const box = boxPercent(block.bbox, size);
      const color = typeColor(block.type);
      return (
        <div
          key={block.id}
          data-block-id={block.id}
          data-type={block.type}
          title={`${block.type}：${block.text}`}
          style={{
            position: 'absolute',
            left: `${box.left}%`,
            top: `${box.top}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: color,
            backgroundColor: `${color}14`,
          }}
        />
      );
    });
}
