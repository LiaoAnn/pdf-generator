// T13's detail readers: the contract fields for table, checkbox and formula
// blocks and the declared text of an image, from what `collect` read.
import type { GtBlock } from '@pdf-generator/contract';
import { type DetailReaders, GroundTruthError, pageBbox } from './build.ts';
import type { ElementDetails, MeasuredElement } from './measurement.ts';

type GtTable = Extract<GtBlock, { type: 'table' }>['table'];
type GtCell = GtTable['cells'][number];

const detailsOf = (element: MeasuredElement): ElementDetails =>
  (element.details ?? {}) as ElementDetails;

/**
 * A checkbox's state: `data-gt-checked="true|false"`, else its single checkbox
 * or radio input. Inputs that disagree with the attribute, no source, or
 * several inputs without the attribute are errors.
 */
function readCheckbox(element: MeasuredElement): { checked: boolean } {
  const declared = element.attributes?.['data-gt-checked'];
  const inputs = detailsOf(element).inputs ?? [];
  if (declared !== undefined) {
    if (declared !== 'true' && declared !== 'false') {
      throw new GroundTruthError([
        `data-gt-checked="${declared}" must be "true" or "false"`,
      ]);
    }
    const checked = declared === 'true';
    if (inputs.some(input => input !== checked)) {
      throw new GroundTruthError([
        `data-gt-checked="${declared}" disagrees with its input's checked state`,
      ]);
    }
    return { checked };
  }
  const [input, ...more] = inputs;
  if (input === undefined) {
    throw new GroundTruthError([
      'checkbox has no state: add data-gt-checked or a checkbox/radio input',
    ]);
  }
  if (more.length > 0) {
    throw new GroundTruthError([
      `checkbox has ${inputs.length} checkbox/radio inputs; without data-gt-checked it needs exactly one`,
    ]);
  }
  return { checked: input };
}

/**
 * A formula's LaTeX, from `data-gt-latex` or its single KaTeX x-tex
 * annotation (both trimmed; when both exist they must agree), and its text:
 * the visible KaTeX rendering, not the MathML copy KaTeX hides.
 */
function readFormula(element: MeasuredElement): {
  latex: string;
  text?: string;
} {
  const { annotations = [], visibleParts = [] } = detailsOf(element);
  const declared = element.attributes?.['data-gt-latex']?.trim();
  const sources = annotations.map(annotation => annotation.trim());
  let latex: string;
  if (declared !== undefined) {
    if (declared === '') {
      throw new GroundTruthError(['data-gt-latex is empty']);
    }
    const other = sources.find(source => source !== declared);
    if (other !== undefined) {
      throw new GroundTruthError([
        `data-gt-latex "${declared}" disagrees with its x-tex annotation "${other}"`,
      ]);
    }
    latex = declared;
  } else {
    const [source, ...more] = sources;
    if (source === undefined || source === '') {
      throw new GroundTruthError([
        'formula has no LaTeX: add data-gt-latex or a non-empty <annotation encoding="application/x-tex">',
      ]);
    }
    if (more.length > 0) {
      throw new GroundTruthError([
        `formula has ${sources.length} x-tex annotations; without data-gt-latex it needs exactly one`,
      ]);
    }
    latex = source;
  }
  return visibleParts.length === 0
    ? { latex }
    : { latex, text: visibleParts.join(' ').trim() };
}

/**
 * An image's text: `data-gt-text` (trimmed), the text the pack declares for
 * it, else its rendered text. Declaring text for an image that also renders
 * text is an error.
 */
function readImage(element: MeasuredElement): { text?: string } {
  const declared = element.attributes?.['data-gt-text'];
  if (declared === undefined) return {};
  if (element.text.trim() !== '') {
    throw new GroundTruthError([
      'data-gt-text is set on an image that also has rendered text',
    ]);
  }
  return { text: declared.trim() };
}

/**
 * A table's grid on this page: each printed cell placed by the HTML table
 * algorithm (the first column a rowspan from above doesn't cover), its
 * rowspan clipped to the printed rows (0 = to the last row).
 */
function readTable(element: MeasuredElement): { table: GtTable } {
  const { table } = detailsOf(element);
  if (table === undefined) {
    throw new GroundTruthError([
      'data-gt="table" must be on a <table> element',
    ]);
  }
  const { rows } = table;
  if (rows.length === 0) {
    throw new GroundTruthError(['table has no printed rows']);
  }
  const covered = rows.map(() => new Set<number>());
  const cells: GtCell[] = [];
  let cols = 0;
  rows.forEach((row, r) => {
    let col = 0;
    for (const cell of row.cells) {
      while (covered[r]?.has(col)) col += 1;
      const left = rows.length - r;
      const rowSpan = cell.rowSpan === 0 ? left : Math.min(cell.rowSpan, left);
      const colSpan = Math.max(cell.colSpan, 1);
      for (let i = 0; i < rowSpan; i += 1) {
        for (let j = 0; j < colSpan; j += 1) covered[r + i]?.add(col + j);
      }
      cells.push({
        row: r,
        col,
        rowSpan,
        colSpan,
        header: cell.header,
        text: cell.text.trim(),
        bbox: pageBbox(cell.rect),
      });
      col += colSpan;
      cols = Math.max(cols, col);
    }
  });
  if (cols === 0) throw new GroundTruthError(['table has no printed cells']);
  return { table: { rows: rows.length, cols, cells } };
}

export const builtInReaders: DetailReaders = {
  table: readTable,
  checkbox: readCheckbox,
  formula: readFormula,
  image: readImage,
};
