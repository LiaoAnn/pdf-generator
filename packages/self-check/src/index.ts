// Checks a printed PDF against its gt.json (T14). Runs in a Worker and in Node:
// no DOM, browser or Node API.
export {
  type PdfDocument,
  type PdfPage,
  type PdfTextItem,
  readPdf,
} from './pdf.ts';
export { missingText, normaliseText } from './text.ts';
