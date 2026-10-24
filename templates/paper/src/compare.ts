// What a printed paper's gt.json must say, given its data.json: the
// acceptance script (src/acceptance.ts) runs it on every fixture of a batch.
import type { GroundTruth } from '@pdf-generator/contract';
import { type FormulaSlot, formulas } from './formulas.ts';

/** The fields of a paper record that `compare` reads (see data/rules.json). */
export type PaperRecord = {
  authors: { name: string; affiliation: string }[];
  received: string;
  accepted: string;
  grant: { school: number; serial: number };
  references: { kind: 'zh' | 'en' }[];
} & Record<FormulaSlot, number>;

type Block = GroundTruth['blocks'][number];

const slots: FormulaSlot[] = ['eq1', 'eq2', 'eq3', 'eq4'];
// gt.json boxes are measured, not snapped: allow a point of rounding.
const tolerance = 1;
const squash = (text: string) => text.replace(/\s/g, '');
const json = JSON.stringify;

function footnotes(record: PaperRecord): string[] {
  const author = record.authors[0];
  return [
    `收稿日期：${record.received}；接受日期：${record.accepted}。`,
    `* 通訊作者：${author?.name}，${author?.affiliation}。`,
    `† 本研究由國科會計畫 NSTC 113-2221-E-${record.grant.school}-${record.grant.serial} 補助。`,
    '1 本文實驗程式碼與資料集將於論文接受後公開。',
  ];
}

/**
 * Everything wrong with one fixture's gt.json against its data.json, as
 * messages; empty when it is right.
 */
export function compare(gt: GroundTruth, record: PaperRecord): string[] {
  const problems: string[] = [];
  const blocks = [...gt.blocks].sort((a, b) => a.order - b.order);
  const ofType = (type: string) => blocks.filter(block => block.type === type);

  const latex = ofType('formula').map(block =>
    'latex' in block ? block.latex : undefined,
  );
  const wantLatex = slots.map(slot => formulas[slot][record[slot]]);
  if (json(latex) !== json(wantLatex)) {
    problems.push(`formulas ${json(latex)}, data asks for ${json(wantLatex)}`);
  }

  const references = ofType('reference');
  if (references.length !== record.references.length) {
    problems.push(
      `${references.length} references, data has ${record.references.length}`,
    );
  }
  references.forEach((block, index) => {
    if (!block.text.startsWith(`[${index + 1}]`)) {
      problems.push(`reference ${index + 1} reads ${json(block.text)}`);
    }
  });

  const notes = ofType('footnote');
  const wantNotes = footnotes(record);
  if (json(notes.map(n => squash(n.text))) !== json(wantNotes.map(squash))) {
    problems.push(
      `footnotes ${json(notes.map(n => n.text))}, data asks for ${json(wantNotes)}`,
    );
  }
  const firstPage = blocks.filter(
    block =>
      block.page === 1 &&
      block.type !== 'footnote' &&
      block.type !== 'page_header',
  );
  const bodyBottom = Math.max(...firstPage.map(block => block.bbox[3]));
  for (const note of notes) {
    if (note.page !== 1) {
      problems.push(`footnote ${note.id} is on page ${note.page}`);
    } else if (note.bbox[1] < bodyBottom) {
      problems.push(`footnote ${note.id} starts above the body's bottom`);
    }
  }

  // The column blocks: from the first body heading on, without the page
  // margins' blocks.
  const start = blocks.findIndex(
    block => block.type === 'heading' && block.text === '1　緒論',
  );
  if (start < 0) problems.push('no heading 1　緒論');
  const columns = blocks
    .slice(Math.max(start, 0))
    .filter(block => block.type !== 'footnote' && block.type !== 'page_header');

  gt.pages.forEach((_, index) => {
    const page = index + 1;
    const header = blocks.find(
      block => block.type === 'page_header' && block.page === page,
    );
    if (!header) {
      problems.push(`page ${page} has no page header`);
      return;
    }
    const [left, , right] = header.bbox;
    const middle = (left + right) / 2;
    const half = (right - left) / 2;
    const onPage = columns.filter(block => block.page === page);
    let seenRight: Block | undefined;
    for (const block of onPage) {
      if (block.bbox[2] - block.bbox[0] > half + tolerance) {
        problems.push(`${block.id} on page ${page} spans both columns`);
      }
      if (block.bbox[0] > middle) {
        seenRight ??= block;
      } else if (seenRight) {
        problems.push(
          `${block.id} in the left column comes after ${seenRight.id} in the right one on page ${page}`,
        );
      }
    }
    if (page === 1 && !onPage.some(block => block.bbox[0] > middle)) {
      problems.push('page 1 has nothing in the right column');
    }
  });
  return problems;
}
