import { readFileSync } from 'node:fs';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { compare, type PaperRecord } from './compare.ts';
import { type FormulaSlot, formulas } from './formulas.ts';

// Slice 2's printed, self-checked and visually checked fixture: retain its
// actual boxes, including full-width front matter and wide first-page notes.
const printed = gtSchema.parse(
  JSON.parse(
    readFileSync(new URL('./fixtures/gt.json', import.meta.url), 'utf8'),
  ),
);
const record: PaperRecord = JSON.parse(
  readFileSync(new URL('./fixtures/data.json', import.meta.url), 'utf8'),
);
type Block = GroundTruth['blocks'][number];

function blocks<T extends Block['type']>(gt: GroundTruth, type: T) {
  return gt.blocks
    .filter((b): b is Block & { type: T } => b.type === type)
    .sort((a, b) => a.order - b.order);
}

function at<T>(items: T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Fixture item ${index} is missing`);
  return item;
}

function header(gt: GroundTruth, page: number) {
  return at(blocks(gt, 'page_header').filter(b => b.page === page));
}

function columns(gt: GroundTruth, page: number) {
  const start = at(blocks(gt, 'heading').filter(b => b.text === '1　緒論'));
  return gt.blocks
    .filter(
      b =>
        b.page === page &&
        b.order >= start.order &&
        b.type !== 'page_header' &&
        b.type !== 'footnote',
    )
    .sort((a, b) => a.order - b.order);
}

function reject(gt: GroundTruth, data = record) {
  const problems = compare(gt, data);
  expect(problems.length).toBeGreaterThan(0);
  for (const problem of problems)
    expect(problem.trim().length).toBeGreaterThan(0);
}

describe('printed paper acceptance comparison', () => {
  it('accepts the real three-page print, including full-width front matter and footnotes', () => {
    expect(compare(structuredClone(printed), structuredClone(record))).toEqual(
      [],
    );
  });

  it('uses global order rather than array position for formulas, references, notes and columns', () => {
    const gt = structuredClone(printed);
    gt.blocks.reverse();
    expect(compare(gt, record)).toEqual([]);
  });

  it.each(['eq1', 'eq2', 'eq3', 'eq4'] as const)(
    'rejects the wrong option LaTeX in %s even when its rendered text is unchanged',
    slot => {
      const gt = structuredClone(printed);
      const index = Number(slot.slice(2)) - 1;
      at(blocks(gt, 'formula'), index).latex =
        formulas[slot][(record[slot] + 1) % formulas[slot].length] ?? '';
      reject(gt);
    },
  );

  it('checks each record-selected formula option instead of hard-coding the sample', () => {
    const gt = structuredClone(printed);
    const data = structuredClone(record);
    for (const [index, slot] of (
      ['eq1', 'eq2', 'eq3', 'eq4'] as FormulaSlot[]
    ).entries()) {
      data[slot] = (data[slot] + 1) % formulas[slot].length;
      at(blocks(gt, 'formula'), index).latex = formulas[slot][data[slot]] ?? '';
    }
    expect(compare(gt, data)).toEqual([]);
  });

  it.each(['formula', 'reference', 'footnote'] as const)(
    'rejects a missing %s block rather than only checking surviving blocks',
    type => {
      const gt = structuredClone(printed);
      const removed = at(blocks(gt, type));
      gt.blocks = gt.blocks.filter(b => b.id !== removed.id);
      reject(gt);
    },
  );

  it.each(['formula', 'reference', 'footnote'] as const)(
    'rejects an extra %s block rather than ignoring surplus blocks',
    type => {
      const gt = structuredClone(printed);
      gt.blocks.push({
        ...structuredClone(at(blocks(gt, type))),
        id: `extra-${type}`,
        order: gt.blocks.length,
      });
      reject(gt);
    },
  );

  it('rejects formulas whose order fields swap slots while array order stays correct', () => {
    const gt = structuredClone(printed);
    const first = at(blocks(gt, 'formula'));
    const second = at(blocks(gt, 'formula'), 1);
    [first.order, second.order] = [second.order, first.order];
    reject(gt);
  });

  it('rejects a bibliography with the right count but a wrong numbered prefix', () => {
    const gt = structuredClone(printed);
    const reference = at(blocks(gt, 'reference'), 3);
    reference.text = reference.text.replace('[4]', '[40]');
    reject(gt);
  });

  it('rejects bibliography numbering that follows array position instead of reading order', () => {
    const gt = structuredClone(printed);
    const first = at(blocks(gt, 'reference'));
    const second = at(blocks(gt, 'reference'), 1);
    [first.order, second.order] = [second.order, first.order];
    reject(gt);
  });

  it('uses the record bibliography length rather than a fixed fixture count', () => {
    const data = structuredClone(record);
    data.references.push({ kind: 'zh' });
    reject(structuredClone(printed), data);
  });

  it.each([0, 1, 2, 3])('rejects incorrect content in footnote %i', index => {
    const gt = structuredClone(printed);
    at(blocks(gt, 'footnote'), index).text += '錯誤';
    reject(gt);
  });

  it.each([
    'received',
    'accepted',
    'author name',
    'affiliation',
    'school',
    'serial',
  ])(
    'compares footnotes against record %s instead of the saved sample',
    field => {
      const data = structuredClone(record);
      if (field === 'received') data.received = '2024-01-01';
      if (field === 'accepted') data.accepted = '2024-12-31';
      if (field === 'author name') at(data.authors).name = '王小明';
      if (field === 'affiliation')
        at(data.authors).affiliation = '國立清華大學';
      if (field === 'school') data.grant.school += 1;
      if (field === 'serial') data.grant.serial += 1;
      reject(structuredClone(printed), data);
    },
  );

  it('accepts whitespace introduced by footnote line wrapping', () => {
    const gt = structuredClone(printed);
    for (const note of blocks(gt, 'footnote')) {
      note.text = ` \n${note.text.replace(/\s/g, '').split('').join(' \n')}\t`;
    }
    expect(compare(gt, record)).toEqual([]);
  });

  it('rejects footnotes whose order fields swap while array order stays correct', () => {
    const gt = structuredClone(printed);
    const first = at(blocks(gt, 'footnote'));
    const second = at(blocks(gt, 'footnote'), 1);
    [first.order, second.order] = [second.order, first.order];
    reject(gt);
  });

  it('rejects a footnote moved off the first page', () => {
    const gt = structuredClone(printed);
    at(blocks(gt, 'footnote')).page = 2;
    reject(gt);
  });

  it('rejects a footnote whose top overlaps the lowest body block', () => {
    const gt = structuredClone(printed);
    const bottom = Math.max(
      ...gt.blocks
        .filter(
          b => b.page === 1 && !['page_header', 'footnote'].includes(b.type),
        )
        .map(b => b.bbox[3]),
    );
    at(blocks(gt, 'footnote')).bbox[1] = bottom - 2;
    reject(gt);
  });

  it('accepts a footnote starting exactly at the lowest body bottom', () => {
    const gt = structuredClone(printed);
    at(blocks(gt, 'footnote')).bbox[1] = Math.max(
      ...gt.blocks
        .filter(
          b => b.page === 1 && !['page_header', 'footnote'].includes(b.type),
        )
        .map(b => b.bbox[3]),
    );
    expect(compare(gt, record)).toEqual([]);
  });

  it.each([1, 2, 3])('rejects page %i without its own page header', page => {
    const gt = structuredClone(printed);
    gt.blocks = gt.blocks.filter(b => b.id !== header(gt, page).id);
    reject(gt);
  });

  it.each([1, 2, 3])(
    'rejects a block spanning both columns on page %i',
    page => {
      const gt = structuredClone(printed);
      const block = at(columns(gt, page));
      const extent = header(gt, page).bbox;
      block.bbox[0] = extent[0];
      block.bbox[2] = extent[2];
      reject(gt);
    },
  );

  it('uses each page header width instead of the PDF page width for column limits', () => {
    const gt = structuredClone(printed);
    const block = at(columns(gt, 2));
    const extent = header(gt, 2).bbox;
    // 270 pt fits half of A4, but exceeds half of the 493 pt text area.
    block.bbox[2] = block.bbox[0] + (extent[2] - extent[0]) / 2 + 20;
    reject(gt);
  });

  it.each([1, 2])(
    'rejects a right-column block ordered before a left-column block on page %i',
    page => {
      const gt = structuredClone(printed);
      const extent = header(gt, page).bbox;
      const middle = (extent[0] + extent[2]) / 2;
      const body = columns(gt, page);
      const left = at(
        body.filter(b => b.bbox[0] <= middle),
        1,
      );
      const right = at(body.filter(b => b.bbox[0] > middle));
      [left.order, right.order] = [right.order, left.order];
      reject(gt);
    },
  );

  it('rejects a first page with no right-column body blocks', () => {
    const gt = structuredClone(printed);
    const extent = header(gt, 1).bbox;
    const middle = (extent[0] + extent[2]) / 2;
    for (const block of columns(gt, 1).filter(b => b.bbox[0] > middle)) {
      const width = block.bbox[2] - block.bbox[0];
      block.bbox[0] = extent[0];
      block.bbox[2] = extent[0] + width;
    }
    reject(gt);
  });

  it('recomputes column midpoints from shifted page headers instead of fixed x coordinates', () => {
    const gt = structuredClone(printed);
    for (const page of gt.pages) page.width += 400;
    for (const block of gt.blocks) {
      block.bbox[0] += 400;
      block.bbox[2] += 400;
    }
    expect(compare(gt, record)).toEqual([]);
  });

  it('returns multiple independent problems instead of stopping after the first failure', () => {
    const gt = structuredClone(printed);
    at(blocks(gt, 'formula')).latex = 'x = 0';
    at(blocks(gt, 'reference')).text = '[99] Incorrect reference';
    at(blocks(gt, 'footnote')).text = 'Incorrect footnote';
    const problems = compare(gt, record);
    expect(problems.length).toBeGreaterThanOrEqual(3);
    for (const problem of problems)
      expect(problem.trim().length).toBeGreaterThan(0);
  });
});
