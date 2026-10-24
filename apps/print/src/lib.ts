// Printing a document on a Browser Rendering tab. Exported for the print
// Worker's routes and for T08 (ground truth), which reads boxes on the same
// tab through `inspect` before the PDF is printed (T03 Must 3).
import type { Browser, CDPSession, Page } from '@cloudflare/puppeteer';
import { type ExpectedBlock, missingText } from '@pdf-generator/self-check';
import { getDocumentProxy } from 'unpdf';
import {
  type PrintStore,
  type PublishedFiles,
  publishFiles,
} from './pack-files.ts';
import { prepareHtml } from './prepare.ts';
import type { PrintRequest } from './request.ts';

export {
  type PrintStore,
  packLimits,
  packSizeIssues,
  servePackFile,
} from './pack-files.ts';
export { prepareHtml } from './prepare.ts';
export {
  type PageSettings,
  type PrintRequest,
  printRequestSchema,
} from './request.ts';
export {
  closeIdleSessions,
  connectSession,
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
   * Per page, each `[data-gt]` element's box and the text of its visible text
   * nodes (NFKC, no whitespace): what the PDF's text layer must contain
   * there.
   */
  expectedText?: ExpectedBlock[][];
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
  | 'text_missing'
  | 'page_count_mismatch'
  | 'request_blocked';

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
  /**
   * Origin of the print Worker, which the browser loads the document, the
   * pack files (`/pack/…`), `/fonts/…` and Paged.js from.
   */
  assetOrigin: string;
  /** Keeps the document and pack files while the tab loads them. */
  store: PrintStore;
  /** Runs on the paginated tab, before it is printed. */
  inspect?: (page: PrintPage) => Promise<T>;
  timeoutMs?: number;
}

export interface RenderResult<T> {
  pdf: Uint8Array;
  pageCount: number;
  inspected: T | undefined;
}

// The platform's own files on the print Worker: the runtime, Paged.js and
// the fonts. Chrome also asks for /favicon.ico by itself.
const runtimePaths = new Set(['/print-runtime.js', '/paged.polyfill.js']);
const isFavicon = (url: URL) => url.pathname === '/favicon.ico';

/**
 * Answers every request `cdp` pauses: continues it when `allow` says so,
 * fails it otherwise. Returns `settle`, which resolves once every answer sent
 * so far is acknowledged (or refused). Chrome continues each request that is
 * still paused when the session detaches, so a session must settle before it
 * goes (T07-8).
 */
async function answerRequests(
  cdp: CDPSession,
  allow: (url: string) => boolean,
): Promise<() => Promise<void>> {
  const answering = new Set<Promise<unknown>>();
  cdp.on('Fetch.requestPaused', event => {
    const { requestId } = event;
    const answer = (
      allow(event.request.url + (event.request.urlFragment ?? ''))
        ? cdp.send('Fetch.continueRequest', { requestId })
        : cdp.send('Fetch.failRequest', {
            requestId,
            errorReason: 'BlockedByClient',
          })
    ).catch(() => undefined);
    answering.add(answer);
    void answer.then(() => answering.delete(answer));
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return async () => {
    while (answering.size > 0) await Promise.all(answering);
  };
}

/**
 * Lets the tab load only the print's files and the platform's, and fails
 * everything else, reporting it to `onBlocked`. Interception only continues
 * or fails: the browser loads every file by URL itself (T03 Must not 3).
 * data: URLs can't be intercepted; what they load in turn can. The session
 * is our own rather than puppeteer's interception, so `settle` knows every
 * paused request, including those puppeteer holds back until it can pair
 * them with their network event. Await `settle` before closing the tab.
 */
async function blockOtherRequests(
  page: Page,
  origin: string,
  files: PublishedFiles,
  onBlocked: (url: string) => void,
): Promise<() => Promise<void>> {
  // As puppeteer's interception did: a cached response skips Fetch.
  await page.setCacheEnabled(false);
  return answerRequests(await page.createCDPSession(), url => {
    const parsed = URL.parse(url);
    const platform =
      parsed?.origin === origin &&
      (runtimePaths.has(parsed.pathname) ||
        parsed.pathname.startsWith('/fonts/'));
    if (url.startsWith('data:') || platform || files.serves(url)) return true;
    if (!(parsed?.origin === origin && isFavicon(parsed))) onBlocked(url);
    return false;
  });
}

/**
 * Fails, for every tab of `browser`, each request that leaves the print
 * Worker's origin, until the returned function detaches it. Settling the tab
 * is not enough: under load, requests the document started before the
 * render ended (Paged.js fetches an @import'ed sheet a second time) still
 * reached the tab's interception as it closed, and Chrome let them out. This
 * session outlives the tab and catches them (T07-8). It allows the whole
 * origin, not this print's files: other prints may share the browser.
 */
async function guardBrowser(
  browser: Browser,
  origin: string,
): Promise<() => Promise<void>> {
  const cdp = await browser.target().createCDPSession();
  const settle = await answerRequests(
    cdp,
    url => url.startsWith('data:') || URL.parse(url)?.origin === origin,
  );
  return async () => {
    await settle();
    await cdp.detach().catch(() => undefined);
  };
}

/**
 * Prints one document on a new tab of `browser`, then closes the tab and
 * deletes the print's files from the store. A tab that requested anything
 * but its files fails with `request_blocked`, whatever else happened.
 */
export async function renderPdf<T = undefined>(
  browser: Browser,
  request: PrintRequest,
  options: RenderOptions<T>,
): Promise<RenderResult<T>> {
  const unguard = await guardBrowser(browser, options.assetOrigin);
  const page = await browser.newPage().catch(async (error: unknown) => {
    await unguard();
    throw error;
  });
  let files: PublishedFiles | undefined;
  const blocked = new Set<string>();
  const blockedError = () =>
    new RenderError(
      'request_blocked',
      'The page requested URLs that are not files of its pack',
      [...blocked],
    );
  // The first blocked request ends the render: a page missing a stylesheet
  // would otherwise keep Paged.js from ever finishing.
  let stop: (error: RenderError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  stopped.catch(() => undefined);
  let settle: (() => Promise<void>) | undefined;
  try {
    files = await publishFiles(
      options.store,
      options.assetOrigin,
      prepareHtml(request.html, { page: request.page }),
      request.pack,
    );
    settle = await blockOtherRequests(page, options.assetOrigin, files, url => {
      blocked.add(url);
      stop(blockedError());
    });
    const printing = print(page, files.documentUrl, options);
    printing.catch(() => undefined);
    const result = await Promise.race([printing, stopped]).catch(
      (error: unknown) => {
        throw blocked.size > 0 ? blockedError() : error;
      },
    );
    if (blocked.size > 0) throw blockedError();
    return result;
  } finally {
    await settle?.();
    await page.close().catch(() => undefined);
    await files?.remove();
    await unguard();
  }
}

async function print<T>(
  page: Page,
  documentUrl: string,
  options: RenderOptions<T>,
): Promise<RenderResult<T>> {
  await page.goto(documentUrl);
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
  // Content Paged.js didn't lay out (a pack's own pagedjs-content template
  // leaves the rest of <body> live) or CSS on its page boxes can add sheets
  // that no gt.json page describes (T08-1).
  const { numPages } = await getDocumentProxy(new Uint8Array(pdf));
  if (numPages !== ready.pageCount) {
    throw new RenderError(
      'page_count_mismatch',
      'The PDF has a different number of pages than Paged.js made',
      [`PDF pages: ${numPages}; Paged.js pages: ${ready.pageCount}`],
    );
  }
  if (
    ready.expectedText?.some(blocks =>
      blocks.some(block => block.texts.length > 0),
    )
  ) {
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
}
