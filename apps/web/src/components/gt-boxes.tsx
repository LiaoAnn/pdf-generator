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
  selectedId,
  onSelect,
}: {
  blocks: readonly GtBlock[];
  page: number;
  size: { width: number; height: number };
  hidden: ReadonlySet<BlockType>;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  return blocks
    .filter(block => block.page === page && !hidden.has(block.type))
    .map(block => {
      const box = boxPercent(block.bbox, size);
      const color = typeColor(block.type);
      const selected = block.id === selectedId;
      return (
        <button
          key={block.id}
          type="button"
          data-block-id={block.id}
          data-type={block.type}
          data-selected={selected || undefined}
          aria-label={`${block.type}：${block.text}`}
          title={`${block.type}：${block.text}`}
          onClick={() => onSelect?.(block.id)}
          className="cursor-pointer"
          style={{
            position: 'absolute',
            left: `${box.left}%`,
            top: `${box.top}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
            borderWidth: selected ? 3 : 1,
            borderStyle: 'solid',
            borderColor: color,
            backgroundColor: `${color}${selected ? '40' : '14'}`,
            padding: 0,
          }}
        />
      );
    });
}
