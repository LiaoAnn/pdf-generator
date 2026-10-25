// Printing a document on a Browser Rendering tab. Exported for the print
// Worker's routes and for T08 (ground truth), which reads boxes on the same
// tab through `inspect` before the PDF is printed (T03 Must 3).
import type { Browser, Page } from '@cloudflare/puppeteer';
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
   * `"page <n> <box> <property>: <value>"` of every Paged.js page box (or
   * html/body) a template moved from where Paged.js put it, on screen.
   */
  movedBoxes?: string[];
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
  | 'page_box_moved'
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
 * Lets the tab load only the print's files and the platform's, and fails
 * everything else, reporting it to `onBlocked`. Interception only continues
 * or fails: the browser loads every file by URL itself (T03 Must not 3).
 * data: URLs can't be intercepted; what they load in turn can.
 *
 * Returns `settle`, which resolves once every answer sent so far is
 * acknowledged (or refused): Chrome continues each request still paused
 * when the session detaches, so the tab must settle before it closes. The
 * session is our own rather than puppeteer's interception, which holds back
 * paused requests it can't yet pair with their network event. Settling
 * can't cover requests still on their way to the session as the tab closes
 * (Paged.js fetches an @import'ed sheet a second time); the print's proxy
 * keeps those from leaving (see `printContext`).
 */
async function blockOtherRequests(
  page: Page,
  origin: string,
  files: PublishedFiles,
  onBlocked: (url: string) => void,
): Promise<() => Promise<void>> {
  const allow = (url: string) => {
    const parsed = URL.parse(url);
    const platform =
      parsed?.origin === origin &&
      (runtimePaths.has(parsed.pathname) ||
        parsed.pathname.startsWith('/fonts/'));
    if (url.startsWith('data:') || platform || files.serves(url)) return true;
    if (!(parsed?.origin === origin && isFavicon(parsed))) onBlocked(url);
    return false;
  };
  // As puppeteer's interception did: a cached response skips Fetch.
  await page.setCacheEnabled(false);
  const cdp = await page.createCDPSession();
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

// Nothing listens on the discard port, so a connection to it is refused.
const refusingProxy = 'http://127.0.0.1:9';

/**
 * A browser context for one print whose connections all go to a proxy that
 * refuses them, except those to the print Worker. Interception decides what
 * the tab may load; this makes sure nothing else leaves, whatever the timing:
 * Chrome continues requests still paused when a DevTools session detaches,
 * and under load about 1 print in 150 sent a blocked request to the outside
 * server that way, even with a browser-level session as a backstop, which
 * could detach before the released request reached it (T07-8). It also
 * covers connections without a request, such as <link rel=preconnect>.
 * `<-loopback>` stops Chrome from bypassing the proxy for loopback hosts.
 */
function printContext(browser: Browser, origin: string) {
  // A rule without scheme and port would let every port of the host through.
  const { protocol, hostname, port } = new URL(origin);
  const effectivePort = port || (protocol === 'https:' ? '443' : '80');
  return browser.createBrowserContext({
    proxyServer: refusingProxy,
    proxyBypassList: [
      '<-loopback>',
      `${protocol}//${hostname}:${effectivePort}`,
    ],
  });
}

/**
 * Prints one document on a new tab of `browser`, in a context of its own,
 * then closes both and deletes the print's files from the store. A tab that requested anything
 * but its files fails with `request_blocked`, whatever else happened.
 */
export async function renderPdf<T = undefined>(
  browser: Browser,
  request: PrintRequest,
  options: RenderOptions<T>,
): Promise<RenderResult<T>> {
  const context = await printContext(browser, options.assetOrigin);
  const page = await context.newPage().catch(async (error: unknown) => {
    await context.close().catch(() => undefined);
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
    await context.close().catch(() => undefined);
  }
}

function rejectMovedBoxes(moved: string[] | undefined) {
  if (moved && moved.length > 0) {
    throw new RenderError(
      'page_box_moved',
      'The template moved Paged.js page boxes or html/body',
      moved,
    );
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
  // Ground truth is read relative to each page's box, so a page box a
  // template moved misplaces every block in it (T07-18).
  rejectMovedBoxes(ready.movedBoxes);
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
  // Again as printed: Paged.js leaves screen-only stylesheets live, and its
  // own @media print rules apply only here.
  await page.emulateMediaType('print');
  const printed = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __pdfgen: {
          movedBoxes(options: { print: boolean }): string[];
        };
      }
    ).__pdfgen.movedBoxes({ print: true }),
  );
  rejectMovedBoxes(printed);
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
