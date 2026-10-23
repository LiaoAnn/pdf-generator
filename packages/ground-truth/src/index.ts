// Reads gt.json from a page Paged.js has finished paginating (T08; T13 adds
// table, checkbox and formula details through detail readers).
export {
  type BuildOptions,
  buildGroundTruth,
  type DetailReader,
  type DetailReaders,
  GroundTruthError,
} from './build.ts';
export type {
  MeasuredElement,
  MeasuredPage,
  Measurement,
  Rect,
  Region,
} from './measurement.ts';
export { type EvaluatingPage, readGroundTruth } from './read.ts';
