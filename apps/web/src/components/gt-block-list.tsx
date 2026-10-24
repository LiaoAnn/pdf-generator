import type { BlockType, GtBlock } from '@pdf-generator/contract';
import { typeColor } from '../batches/overlay';

/**
 * The answer list: the gt.json blocks of visible types in reading order,
 * one selectable row each, linked to the boxes by block id.
 */
export function GtBlockList({
  blocks,
  hidden,
  selectedId,
  onSelect,
}: {
  blocks: readonly GtBlock[];
  hidden: ReadonlySet<BlockType>;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const rows = blocks
    .filter(block => !hidden.has(block.type))
    .sort((a, b) => a.order - b.order);
  return (
    <div role="listbox" aria-label="答案清單" className="flex flex-col">
      {rows.map(block => {
        const selected = block.id === selectedId;
        const color = typeColor(block.type);
        return (
          <button
            key={block.id}
            type="button"
            role="option"
            data-block-row={block.id}
            aria-selected={selected}
            onClick={() => onSelect(block.id)}
            className="flex flex-col gap-0.5 border-l-4 px-2 py-1.5 text-left text-sm hover:bg-muted"
            style={{
              borderLeftColor: color,
              ...(selected && { backgroundColor: `${color}33` }),
            }}>
            <span className="text-muted-foreground text-xs">
              #{block.order} · {block.type} · 第 {block.page} 頁
            </span>
            <span className="line-clamp-2 break-all">
              {block.text || '（空白）'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
