// What a printed meeting record's gt.json must say, given its data.json: the
// acceptance script (src/acceptance.ts) runs it on every fixture of a batch.
import type { GroundTruth } from '@pdf-generator/contract';

/** A minimal-example record (see pack/data/rules.json). */
export type MeetingRecord = {
  company: string;
  meetingDate: string;
  place: string;
  chair: string;
  recorder: string | null;
  attendees: { name: string; title: string; present: boolean }[];
  summary: string;
  items: string[];
  confirmed: boolean;
};

type Expected = { type: string; text?: string; checked?: boolean };

const json = JSON.stringify;
const box = (checked: boolean) => (checked ? '☑' : '☐');

/** Every block template.hbs prints for the record, in reading order. */
function expectedBlocks(record: MeetingRecord): Expected[] {
  const pairs: [string, string | null][] = [
    ['會議日期：', record.meetingDate],
    ['會議地點：', record.place],
    ['主　　席：', record.chair],
    // A blank recorder is still a field block: empty text over its fill-in line.
    ['記　　錄：', record.recorder],
  ];
  return [
    { type: 'title', text: `${record.company}業務會議紀錄` },
    ...pairs.flatMap(([label, value]) => [
      { type: 'label', text: label },
      { type: 'field', text: value ?? '' },
    ]),
    { type: 'heading', text: '一、出席人員' },
    { type: 'table' },
    { type: 'heading', text: '二、討論事項' },
    { type: 'paragraph', text: record.summary },
    ...record.items.map(item => ({ type: 'list_item', text: `・${item}` })),
    { type: 'heading', text: '三、確認' },
    {
      type: 'checkbox',
      text: `${box(record.confirmed)}本紀錄已經主席確認無誤。`,
      checked: record.confirmed,
    },
    {
      type: 'page_footer',
      text: '本文件內容為測試用假資料，與真實人物、公司無關。',
    },
  ];
}

/** The attendee table's cells, row by row: [row, col, text, checkboxes]. */
function expectedCells(record: MeetingRecord): unknown[] {
  return [
    ['姓名', '職稱', '是否出席'].map((text, col) => [0, col, text, null]),
    ...record.attendees.map(({ name, title, present }, i) => [
      [i + 1, 0, name, null],
      [i + 1, 1, title, null],
      [
        i + 1,
        2,
        `${box(present)}是　${box(!present)}否`,
        [
          ['是', present],
          ['否', !present],
        ],
      ],
    ]),
  ].flat();
}

/**
 * Everything wrong with one fixture's gt.json against its data.json, as
 * messages; empty when it is right.
 */
export function compare(gt: GroundTruth, record: MeetingRecord): string[] {
  const problems: string[] = [];
  const blocks = [...gt.blocks].sort((a, b) => a.order - b.order);
  const expected = expectedBlocks(record);
  if (blocks.length !== expected.length) {
    problems.push(
      `${blocks.length} blocks, the record prints ${expected.length}: ${json(blocks.map(block => block.type))}`,
    );
  }
  expected.forEach((want, i) => {
    const block = blocks[i];
    const got: Expected | undefined = block && {
      type: block.type,
      ...(want.text === undefined ? {} : { text: block.text }),
      ...(want.checked === undefined
        ? {}
        : { checked: block.type === 'checkbox' ? block.checked : undefined }),
    };
    if (json(got) !== json(want)) {
      problems.push(`block ${i}: gt.json ${json(got)}, expected ${json(want)}`);
    }
  });
  const tables = blocks.filter(block => block.type === 'table');
  const cells = tables[0]?.table.cells.map(cell => [
    cell.row,
    cell.col,
    cell.text,
    cell.checkboxes?.map(checkbox => [checkbox.text, checkbox.checked]) ?? null,
  ]);
  if (json(cells) !== json(expectedCells(record))) {
    problems.push(
      `attendee table cells ${json(cells)}, expected ${json(expectedCells(record))}`,
    );
  }
  return problems;
}
