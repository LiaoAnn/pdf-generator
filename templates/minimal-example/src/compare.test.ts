import { readFileSync } from 'node:fs';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { describe, expect, it } from 'vitest';
import { compare, type MeetingRecord } from './compare.ts';

// Real, self-checked prints from seed t10-2: 0000 and 0004 respectively.
function fixture(name: string) {
  const read = (file: string) =>
    JSON.parse(
      readFileSync(
        new URL(`./fixtures/${name}/${file}.json`, import.meta.url),
        'utf8',
      ),
    );
  return {
    gt: gtSchema.parse(read('gt')),
    record: read('data') as MeetingRecord,
  };
}

const filled = fixture('filled');
const blank = fixture('blank-recorder');
type Block = GroundTruth['blocks'][number];

function at<T>(items: T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Fixture item ${index} is missing`);
  return item;
}

function blocks<T extends Block['type']>(gt: GroundTruth, type: T) {
  return gt.blocks
    .filter((b): b is Block & { type: T } => b.type === type)
    .sort((a, b) => a.order - b.order);
}

function cell(gt: GroundTruth, row: number, col: number) {
  return at(
    at(blocks(gt, 'table')).table.cells.filter(
      c => c.row === row && c.col === col,
    ),
  );
}

function reject(gt: GroundTruth, record: MeetingRecord, relevant?: RegExp) {
  const problems = compare(gt, record);
  expect(problems.length).toBeGreaterThan(0);
  for (const problem of problems) expect(problem.trim()).not.toBe('');
  if (relevant)
    expect(problems.some(problem => relevant.test(problem))).toBe(true);
}

describe('printed meeting record acceptance comparison', () => {
  it.each([
    ['filled recorder (0000)', filled],
    ['blank recorder (0004)', blank],
  ] as const)('accepts the real print with %s', (_name, fixture) => {
    expect(
      compare(structuredClone(fixture.gt), structuredClone(fixture.record)),
    ).toEqual([]);
  });

  it('uses reading order rather than serialized block array position', () => {
    const gt = structuredClone(blank.gt);
    gt.blocks.reverse();
    expect(compare(gt, structuredClone(blank.record))).toEqual([]);
  });

  it('reports invented recorder text when the record is null', () => {
    const gt = structuredClone(blank.gt);
    at(blocks(gt, 'field'), 3).text = '王小明';
    reject(gt, blank.record, /recorder|記.*錄|field/i);
  });

  it('reports a missing blank recorder field instead of treating absence as empty text', () => {
    const gt = structuredClone(blank.gt);
    const recorder = at(blocks(gt, 'field'), 3);
    gt.blocks = gt.blocks.filter(b => b.id !== recorder.id);
    reject(gt, blank.record, /recorder|記.*錄|field/i);
  });

  it.each([
    ['meetingDate', 0],
    ['place', 1],
    ['chair', 2],
    ['recorder', 3],
  ] as const)(
    'reports an emptied %s field from a filled record',
    (_name, index) => {
      const gt = structuredClone(filled.gt);
      at(blocks(gt, 'field'), index).text = '';
      reject(gt, filled.record);
    },
  );

  it.each([0, 1, 2, 3])(
    'reports altered label %i, including full-width spaces',
    index => {
      const gt = structuredClone(filled.gt);
      at(blocks(gt, 'label'), index).text =
        ['日期：', '地點：', '主  席：', '記  錄：'][index] ?? '';
      reject(gt, filled.record);
    },
  );

  it('reports a field that no longer follows its label in reading order', () => {
    const gt = structuredClone(filled.gt);
    const label = at(blocks(gt, 'label'));
    const field = at(blocks(gt, 'field'));
    [label.order, field.order] = [field.order, label.order];
    reject(gt, filled.record);
  });

  it('reports reordered label/field pairs even when each value still follows its label', () => {
    const gt = structuredClone(filled.gt);
    const labels = blocks(gt, 'label');
    const fields = blocks(gt, 'field');
    [at(labels).order, at(labels, 1).order] = [
      at(labels, 1).order,
      at(labels).order,
    ];
    [at(fields).order, at(fields, 1).order] = [
      at(fields, 1).order,
      at(fields).order,
    ];
    reject(gt, filled.record);
  });

  it.each(['title', 'paragraph', 'page_footer'] as const)(
    'reports wrong %s text',
    type => {
      const gt = structuredClone(filled.gt);
      at(blocks(gt, type)).text += '錯';
      reject(gt, filled.record);
    },
  );

  it.each(['title', 'table', 'paragraph', 'checkbox', 'page_footer'] as const)(
    'reports a missing %s block',
    type => {
      const gt = structuredClone(filled.gt);
      gt.blocks = gt.blocks.filter(b => b.type !== type);
      reject(gt, filled.record);
    },
  );

  it.each(['title', 'table', 'paragraph', 'checkbox', 'page_footer'] as const)(
    'reports a duplicate %s block',
    type => {
      const gt = structuredClone(filled.gt);
      const duplicate = structuredClone(at(blocks(gt, type)));
      duplicate.id += '-duplicate';
      duplicate.order = 100;
      gt.blocks.push(duplicate);
      reject(gt, filled.record);
    },
  );

  it.each([0, 1, 2])(
    'reports wrong attendee table header in column %i',
    col => {
      const gt = structuredClone(blank.gt);
      cell(gt, 0, col).text = '錯誤表頭';
      reject(gt, blank.record);
    },
  );

  it.each([
    ['name', 0],
    ['title', 1],
  ] as const)('reports wrong attendee %s', (_name, col) => {
    const gt = structuredClone(blank.gt);
    cell(gt, 1, col).text = '另一位出席者';
    reject(gt, blank.record);
  });

  it('reports a missing attendee row', () => {
    const gt = structuredClone(blank.gt);
    const table = at(blocks(gt, 'table')).table;
    table.cells = table.cells.filter(c => c.row < table.rows - 1);
    table.rows -= 1;
    reject(gt, blank.record);
  });

  it.each([1, 4])(
    'reports the wrong attendance checkbox state for row %i',
    row => {
      const gt = structuredClone(blank.gt);
      const checkboxes = cell(gt, row, 2).checkboxes;
      if (!checkboxes)
        throw new Error('Fixture attendance checkboxes are missing');
      // Leave aggregate cell/block text unchanged: structured metadata must be checked.
      for (const checkbox of checkboxes) checkbox.checked = !checkbox.checked;
      reject(gt, blank.record);
    },
  );

  it.each([0, 1])(
    'reports the wrong attendance option label at index %i',
    index => {
      const gt = structuredClone(blank.gt);
      at(cell(gt, 1, 2).checkboxes ?? [], index).text = '也許';
      reject(gt, blank.record);
    },
  );

  it('reports missing structured attendance checkboxes even when cell text is right', () => {
    const gt = structuredClone(blank.gt);
    delete cell(gt, 1, 2).checkboxes;
    reject(gt, blank.record);
  });

  it('reports a missing list item', () => {
    const gt = structuredClone(filled.gt);
    const item = at(blocks(gt, 'list_item'));
    gt.blocks = gt.blocks.filter(b => b.id !== item.id);
    reject(gt, filled.record);
  });

  it('reports list items swapped in reading order', () => {
    const gt = structuredClone(filled.gt);
    const items = blocks(gt, 'list_item');
    [at(items).order, at(items, 1).order] = [
      at(items, 1).order,
      at(items).order,
    ];
    reject(gt, filled.record);
  });

  it('reports a list item whose printed bullet is missing', () => {
    const gt = structuredClone(filled.gt);
    const item = at(blocks(gt, 'list_item'));
    item.text = item.text.slice(1);
    reject(gt, filled.record);
  });

  it.each([
    ['unconfirmed', filled],
    ['confirmed', blank],
  ] as const)(
    'reports wrong confirmation metadata for a %s record',
    (_name, fixture) => {
      const gt = structuredClone(fixture.gt);
      at(blocks(gt, 'checkbox')).checked = !fixture.record.confirmed;
      reject(gt, fixture.record);
    },
  );

  it('reports a wrong printed confirmation symbol even when checked is right', () => {
    const gt = structuredClone(blank.gt);
    at(blocks(gt, 'checkbox')).text = '☐本紀錄已經主席確認無誤。';
    reject(gt, blank.record);
  });

  it('returns a separate message for each of two independent text errors', () => {
    const gt = structuredClone(filled.gt);
    at(blocks(gt, 'title')).text = '錯誤公司業務會議紀錄';
    at(blocks(gt, 'paragraph')).text = '錯誤討論摘要';
    const problems = compare(gt, filled.record);
    expect(problems).toHaveLength(2);
    for (const problem of problems) expect(problem.trim()).not.toBe('');
  });
});
