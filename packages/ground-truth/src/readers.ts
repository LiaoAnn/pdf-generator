// T13's detail readers: the contract fields for table, checkbox and formula
// blocks and the declared text of an image, from what `collect` read.
import { type DetailReaders, GroundTruthError } from './build.ts';
import type { ElementDetails, MeasuredElement } from './measurement.ts';

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

export const builtInReaders: DetailReaders = {
  checkbox: readCheckbox,
  formula: readFormula,
  image: readImage,
};
