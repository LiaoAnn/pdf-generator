import {
  type BlockType,
  type GtBlock,
  gtSchema,
} from '@pdf-generator/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { GtBlockList } from './gt-block-list';

const gt = gtSchema.parse(gtExample);

function renderRows({
  blocks = gt.blocks,
  hidden = new Set<BlockType>(),
  selectedId,
}: {
  blocks?: readonly GtBlock[];
  hidden?: ReadonlySet<BlockType>;
  selectedId?: string;
} = {}) {
  const markup = renderToStaticMarkup(
    <GtBlockList
      blocks={blocks}
      hidden={hidden}
      selectedId={selectedId}
      onSelect={() => {}}
    />,
  );
  return [
    ...markup.matchAll(
      /<(\w+)\b([^>]*\bdata-block-row="([^"]*)"[^>]*)>([\s\S]*?)<\/\1>/g,
    ),
  ].map(([, tagName, attributes = '', id, content = '']) => ({
    id,
    tagName,
    buttonType: /\btype="([^"]*)"/.exec(attributes)?.[1],
    selected: /\baria-selected="([^"]*)"/.exec(attributes)?.[1],
    text: content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

describe('GtBlockList', () => {
  it('lists every block once in reading order rather than input array order, including blank fields', () => {
    const shuffled = [...gt.blocks].reverse();
    const originalIds = shuffled.map(block => block.id);
    expect(renderRows({ blocks: shuffled }).map(row => row.id)).toEqual([
      'title',
      'intro',
      'table-first',
      'page-1',
      'table-second',
      'approved',
      'equation',
      'signature',
      'stamp',
      'page-2',
    ]);
    expect(shuffled.map(block => block.id)).toEqual(originalIds);
  });

  it('omits hidden types across all pages and restores their rows when the filter clears', () => {
    const hidden = new Set<BlockType>(['table', 'page_number']);
    expect(renderRows({ hidden }).map(row => row.id)).toEqual([
      'title',
      'intro',
      'approved',
      'equation',
      'signature',
      'stamp',
    ]);
    hidden.clear();
    expect(renderRows({ hidden })).toHaveLength(10);
  });

  it('marks only the matching row selected and clears stale selection for absent or hidden ids', () => {
    for (const selectedId of ['stamp', 'intro', undefined, 'missing']) {
      const rows = renderRows({ selectedId });
      expect(
        rows.filter(row => row.selected === 'true').map(row => row.id),
      ).toEqual(selectedId && selectedId !== 'missing' ? [selectedId] : []);
      for (const row of rows.filter(row => row.id !== selectedId)) {
        expect(row.selected).toBe('false');
      }
    }
    const rows = renderRows({
      selectedId: 'intro',
      hidden: new Set(['paragraph']),
    });
    expect(rows).toHaveLength(9);
    expect(rows.every(row => row.selected === 'false')).toBe(true);
  });

  it('shows each block type, one-based page number and text in its own row', () => {
    const rows = renderRows();
    for (const id of ['intro', 'stamp']) {
      const block = gt.blocks.find(block => block.id === id);
      if (!block) throw new Error(`Contract fixture has no block ${id}`);
      const row = rows.find(row => row.id === id);
      expect(row).toBeDefined();
      expect(row?.text).toContain(block.type);
      expect(row?.text).toMatch(new RegExp(`\\b${block.page}\\b`));
      expect(row?.text).toContain(block.text);
    }
  });

  it('renders every row as a non-submit button so keyboard users can select answers', () => {
    const rows = renderRows();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.tagName).toBe('button');
      expect(row.buttonType).toBe('button');
    }
  });
});
