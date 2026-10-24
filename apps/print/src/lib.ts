// Printing a document on a Browser Rendering tab. Exported for the print
// Worker's routes and for T08 (ground truth), which reads boxes on the same
// tab through `inspect` before the PDF is printed (T03 Must 3).
import type { Browser } from '@cloudflare/puppeteer';
import { missingText } from '@pdf-generator/self-check';
import { prepareHtml } from './prepare.ts';
import type { PrintRequest } from './request.ts';

export { prepareHtml } from './prepare.ts';
export {
  type PageSettings,
  type PrintRequest,
  printRequestSchema,
} from './request.ts';
export {
  type OpenBrowserOptions,
  type OpenedBrowser,
  openBrowser,
} from './session.ts';

/** What the print runtime (public/print-runtime.js) reports once Paged.js is done. */
export interface PrintReadyState {
  pageCount: number;
  /** `"<family> <weight>: <status>"` of every face that is not loaded. */
  unloadedFaces: string[];
  /** `"page <n>: <row text>"` of every table row split or outside its page. */
  fragmentedRows: string[];
  /**
   * Per page, the text of every visible text node inside a `[data-gt]`
   * element (NFKC, no whitespace): what the PDF's text layer must contain.
   */
  expectedText?: string[][];
}

/**
 * The page `inspect` receives: `evaluate` with a function that takes no
 * arguments or with an expression string, which puppeteer and Playwright
 * pages both have.
 */
export interface PrintPage {
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  /** A string expression, as T08's reader uses (no serialised functions). */
  evaluate(expression: string): Promise<unknown>;
}

export type RenderErrorCode =
  | 'pagination_timeout'
  | 'font_not_loaded'
  | 'row_fragmented'
  | 'text_missing';

/** A render that must not produce a PDF. */
export class RenderError extends Error {
  readonly code: RenderErrorCode;
  readonly details: string[];

  constructor(code: RenderErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.details = details;
  }
}

const defaultTimeoutMs = 60_000;

/**
 * Waits until Paged.js has finished paginating a page prepared with
 * `prepareHtml` (its `PagedConfig.after`, T03 Must 1). Rejects with a
 * `pagination_timeout` RenderError after `timeoutMs`.
 */
export async function waitForPrintReady(
  page: PrintPage,
  timeoutMs = defaultTimeoutMs,
): Promise<PrintReadyState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RenderError(
            'pagination_timeout',
            `Paged.js did not finish within ${timeoutMs} ms`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __pdfgen: { ready: Promise<PrintReadyState> };
            }
          ).__pdfgen.ready,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RenderOptions<T> {
  /** Origin the browser loads `/blank`, `/fonts/…` and Paged.js from. */
  assetOrigin: string;
  /** Runs on the paginated tab, before it is printed. */
  inspect?: (page: PrintPage) => Promise<T>;
  timeoutMs?: number;
}

export interface RenderResult<T> {
  pdf: Uint8Array;
  pageCount: number;
  inspected: T | undefined;
}

/** Prints one document on a new tab of `browser`, then closes the tab. */
export async function renderPdf<T = undefined>(
  browser: Browser,
  request: PrintRequest,
  options: RenderOptions<T>,
): Promise<RenderResult<T>> {
  const page = await browser.newPage();
  try {
    await page.goto(`${options.assetOrigin}/blank`);
    await page.setContent(prepareHtml(request.html, { page: request.page }));
    const ready = await waitForPrintReady(page, options.timeoutMs);
    if (ready.unloadedFaces.length > 0) {
      throw new RenderError(
        'font_not_loaded',
        'Some font faces did not load',
        ready.unloadedFaces,
      );
    }
    if (ready.fragmentedRows.length > 0) {
      throw new RenderError(
        'row_fragmented',
        'Some table rows are split or outside their page',
        ready.fragmentedRows,
      );
    }
    const inspected = options.inspect ? await options.inspect(page) : undefined;
    const pdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
    // The PDF is the authority on what was printed (T03 Must 4, PDF part).
    if (ready.expectedText?.some(texts => texts.length > 0)) {
      const missing = await missingText(pdf, ready.expectedText);
      if (missing.length > 0) {
        throw new RenderError(
          'text_missing',
          'Some data-gt text is missing from the PDF',
          missing,
        );
      }
    }
    return { pdf, pageCount: ready.pageCount, inspected };
  } finally {
    await page.close().catch(() => undefined);
  }
}
