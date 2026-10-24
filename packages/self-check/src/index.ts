// Checks a printed PDF against its gt.json (T14). Runs in a Worker and in Node:
// no DOM, browser or Node API.
export {
  type Box,
  type CheckOptions,
  checkPdf,
  type Difference,
  type SelfCheckReport,
} from './check.ts';
export {
  type PdfDocument,
  type PdfMark,
  type PdfPage,
  type PdfTextItem,
  readPdf,
} from './pdf.ts';
export { type ExpectedBlock, missingText, normaliseText } from './text.ts';
