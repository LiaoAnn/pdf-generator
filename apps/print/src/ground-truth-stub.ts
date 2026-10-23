// Stub of T08's reader (`readGroundTruth` from @pdf-generator/ground-truth),
// with its exact signature, until T08 merges: it reports the printed pages
// and no blocks. T08 replaces this import; it reads the data-gt blocks.
import type { GroundTruth } from '@pdf-generator/contract';

/** What T08's reader needs from a page; puppeteer's Page has it. */
export interface GroundTruthPage {
  evaluate(expression: string): Promise<unknown>;
}

// Page boxes in PDF points (CSS px × 0.75, T03 Must 2), in page order.
const pageSizes = `[...document.querySelectorAll('.pagedjs_page')].map(page => {
  const box = page.getBoundingClientRect();
  return {
    width: Math.round(box.width * 75) / 100,
    height: Math.round(box.height * 75) / 100,
  };
})`;

export async function readGroundTruth(
  page: GroundTruthPage,
  source: GroundTruth['source'],
): Promise<GroundTruth> {
  const pages = (await page.evaluate(pageSizes)) as GroundTruth['pages'];
  return { schemaVersion: 1, source, pages, blocks: [] };
}
