import type { GroundTruth } from '@pdf-generator/contract';
import { type BuildOptions, buildGroundTruth } from './build.ts';
import { collect } from './collect.js';
import type { Measurement } from './measurement.ts';
import { builtInReaders } from './readers.ts';

/**
 * The part of a browser page the reader needs: Playwright's and
 * @cloudflare/puppeteer's `Page` both fit. Only a string expression is ever
 * evaluated.
 */
export interface EvaluatingPage {
  evaluate(expression: string): Promise<unknown>;
}

/**
 * Reads gt.json from a page Paged.js has finished paginating (after its
 * `PagedConfig.after`), in the session that prints the PDF (T03 rules 1–3).
 * Table, checkbox and formula details and image text come from the built-in
 * readers; `options.detailReaders` replaces them per type.
 */
export async function readGroundTruth(
  page: EvaluatingPage,
  source: GroundTruth['source'],
  options: BuildOptions = {},
): Promise<GroundTruth> {
  const measurement = (await page.evaluate(collectExpression)) as Measurement;
  return buildGroundTruth(measurement, source, {
    ...options,
    detailReaders: { ...builtInReaders, ...options.detailReaders },
  });
}

const collectExpression = `(${collect.toString()})()`;
