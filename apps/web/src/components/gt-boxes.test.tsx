import {
  type BlockType,
  type GtBlock,
  gtSchema,
} from '@pdf-generator/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { typeColor } from '../batches/overlay';
import { GtBoxes } from './gt-boxes';

const gt = gtSchema.parse(gtExample);

// Inspect only opening tags carrying the public block marker; wrappers and
// attribute order are deliberately irrelevant to these assertions.
function boxes(markup: string) {
  return [...markup.matchAll(/<[^>]+\bdata-block-id="[^"]*"[^>]*>/g)].map(
    ([tag]) => ({
      id: /\bdata-block-id="([^"]*)"/.exec(tag)?.[1],
      type: /\bdata-type="([^"]*)"/.exec(tag)?.[1],
      tagName: /^<(\w+)/.exec(tag)?.[1],
      buttonType: /\btype="([^"]*)"/.exec(tag)?.[1],
      selected: /\bdata-selected="([^"]*)"/.exec(tag)?.[1],
      style: Object.fromEntries(
        (/\bstyle="([^"]*)"/.exec(tag)?.[1] ?? '')
          .split(';')
          .filter(Boolean)
          .map(declaration => {
            const colon = declaration.indexOf(':');
            return [
              declaration.slice(0, colon).trim(),
              declaration.slice(colon + 1).trim(),
            ];
          }),
      ),
    }),
  );
}

function renderPage(page: number, hidden: ReadonlySet<BlockType> = new Set()) {
  const size = gt.pages[page - 1];
  if (!size) throw new Error(`Contract fixture has no page ${page}`);
  return boxes(
    renderToStaticMarkup(
      <GtBoxes blocks={gt.blocks} page={page} size={size} hidden={hidden} />,
    ),
  );
}

describe('GtBoxes', () => {
  it('highlights only the selected id and clears stale highlights when selection changes, disappears, or is hidden', () => {
    const renderSelection = (
      selectedId?: string,
      hidden: ReadonlySet<BlockType> = new Set(),
    ) =>
      boxes(
        renderToStaticMarkup(
          <GtBoxes
            blocks={gt.blocks}
            page={1}
            size={{ width: 595.28, height: 841.89 }}
            hidden={hidden}
            selectedId={selectedId}
            onSelect={() => {}}
          />,
        ),
      )
        .filter(box => box.selected === 'true')
        .map(box => box.id);

    expect(renderSelection('intro')).toEqual(['intro']);
    expect(renderSelection('title')).toEqual(['title']);
    expect(renderSelection()).toEqual([]);
    expect(renderSelection('missing')).toEqual([]);
    expect(renderSelection('stamp')).toEqual([]);
    expect(renderSelection('intro', new Set(['paragraph']))).toEqual([]);
  });

  it('renders every visible box as a non-submit button so keyboard users can select it', () => {
    const rendered = renderPage(1);
    expect(rendered).toHaveLength(4);
    for (const box of rendered) {
      expect(box.tagName).toBe('button');
      expect(box.buttonType).toBe('button');
    }
  });

  it('draws each page-two block once, including blank fields, without drawing nested table cells as blocks', () => {
    const rendered = renderPage(2);
    expect(rendered.map(box => box.id).sort()).toEqual([
      'approved',
      'equation',
      'page-2',
      'signature',
      'stamp',
      'table-second',
    ]);
    for (const block of gt.blocks.filter(block => block.page === 2)) {
      expect(rendered.find(box => box.id === block.id)?.type).toBe(block.type);
    }
  });

  it('does not leak page-two boxes into the first page or treat page numbers as zero-based', () => {
    expect(
      renderPage(1)
        .map(box => box.id)
        .sort(),
    ).toEqual(['intro', 'page-1', 'table-first', 'title']);
  });

  it('removes exactly the hidden types and restores their boxes when the hidden set changes', () => {
    const hidden = new Set<BlockType>(['table', 'page_number']);
    expect(
      renderPage(1, hidden)
        .map(box => box.id)
        .sort(),
    ).toEqual(['intro', 'title']);
    expect(
      renderPage(2, hidden)
        .map(box => box.id)
        .sort(),
    ).toEqual(['approved', 'equation', 'signature', 'stamp']);
    hidden.clear();
    expect(
      renderPage(1, hidden)
        .map(box => box.id)
        .sort(),
    ).toEqual(['intro', 'page-1', 'table-first', 'title']);
  });

  it('positions boxes absolutely with percentage dimensions and the legend colour rather than pixel or bottom-origin coordinates', () => {
    const block: GtBlock = {
      id: 'offset',
      type: 'paragraph',
      page: 1,
      order: 0,
      text: 'Offset content',
      bbox: [20, 120, 80, 200],
    };
    const rendered = boxes(
      renderToStaticMarkup(
        <GtBoxes
          blocks={[block]}
          page={1}
          size={{ width: 200, height: 400 }}
          hidden={new Set()}
        />,
      ),
    );
    expect(rendered).toHaveLength(1);
    const style = rendered[0]?.style ?? {};
    expect(style).toMatchObject({
      position: 'absolute',
      left: '10%',
      top: '30%',
      width: '30%',
      height: '20%',
    });
    const border = style['border-color'] ?? style.border ?? '';
    expect(border).toContain(typeColor('paragraph'));
  });
});
