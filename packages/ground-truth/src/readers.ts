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

export const builtInReaders: DetailReaders = {
  checkbox: readCheckbox,
};
