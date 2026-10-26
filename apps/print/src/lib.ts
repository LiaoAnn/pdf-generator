// Printing a document on a Browser Rendering tab. Exported for the print
// Worker's routes and for T08 (ground truth), which reads boxes on the same
// tab through `inspect`, in print media once the PDF is printed (T03 Must 3,
// T07-20).
import type { Browser, Page } from '@cloudflare/puppeteer';
import { type ExpectedBlock, missingText } from '@pdf-generator/self-check';
import { getDocumentProxy } from 'unpdf';
import {
  type PrintStore,
  type PublishedFiles,
  publishFiles,
} from './pack-files.ts';
import { scaledPages } from './pdf-scale.ts';
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
  /** The largest Paged.js page, in CSS px. */
  pageSize?: { width: number; height: number };
  /** `"<family> <weight>: <status>"` of every face that is not loaded. */
  unloadedFaces: string[];
  /**
   * `"page <n> <box> <property>: <value>"` of every Paged.js page box (or
   * html/body) a template moved from where Paged.js put it, on screen.
   */
  movedBoxes?: string[];
  /**
   * `"<where>: <what>"` of what depends on the viewport without moving a
   * data-gt box (`position: fixed`, `<picture>` sources chosen by media).
   */
  viewportDependent?: string[];
  /** `"<where>: <what>"` of everything that moves over time, on screen. */
  animations?: string[];
  /**
   * `"<page> <left>,<top>,<right>,<bottom>"` of every data-gt box, on screen
   * at the viewport Paged.js paginated at.
   */
  boxes?: string[];
}

/**
 * What the print runtime measures in print media, once the PDF is printed:
 * the layout the PDF shows, which a stylesheet that applies in one medium
 * only can make differ from the screen's (T07-20).
 */
export interface PrintedState {
  /** As `PrintReadyState.viewportDependent`, in print media. */
  viewportDependent?: string[];
  /** As `PrintReadyState.unloadedFaces`, in print media. */
  unloadedFaces?: string[];
  /**
   * `"<page> <left>,<top>,<right>,<bottom>"` (CSS px from the page's top
   * left) of every laid-out `[data-gt]` element.
   */
  boxes?: string[];
  /** As `PrintReadyState.animations`, in print media. */
  animations?: string[];
  /** As `PrintReadyState.movedBoxes`, in print media. */
  movedBoxes?: string[];
  /** `"page <n>: <row text>"` of every table row split or outside its page. */
  fragmentedRows?: string[];
  /**
   * `"page <n> <tag> <how far> its content area"` of every element outside
   * its page's content area in print but not on screen, where Paged.js broke
   * the pages (T07-23).
   */
  outsidePages?: string[];
  /**
   * `"page <n> <tag> clipped <how far> at the <side>"` of every data-gt
   * element or element inside one that an ancestor (`overflow`, `contain:
   * paint`, `clip-path`, ...) clips in print, inside its page's content area
   * (T07-25).
   */
  clippedContent?: string[];
  /**
   * Per page, whether it paints text, a background or a border at its own
   * scale (outside SVG and CSS transforms): what the PDF must draw at 0.75 pt
   * per CSS px unless Chrome shrank the page.
   */
  plainInk?: boolean[];
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
  | 'viewport_dependent'
  | 'css_animation'
  | 'layout_unsettled'
  | 'request_blocked'
  | 'print_overflow'
  | 'content_clipped';

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

/** `work`, or `error()` once `timeoutMs` has passed. */
async function withinTimeout<R>(
  work: Promise<R>,
  timeoutMs: number,
  error: () => RenderError,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until Paged.js has finished paginating a page prepared with
 * `prepareHtml` (its `PagedConfig.after`, T03 Must 1). Rejects with a
 * `pagination_timeout` RenderError after `timeoutMs`.
 */
export async function waitForPrintReady(
  page: PrintPage,
  timeoutMs = defaultTimeoutMs,
): Promise<PrintReadyState> {
  return withinTimeout(
    page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __pdfgen: { ready: Promise<PrintReadyState> };
          }
        ).__pdfgen.ready,
    ),
    timeoutMs,
    () =>
      new RenderError(
        'pagination_timeout',
        `Paged.js did not finish within ${timeoutMs} ms`,
      ),
  );
}

export interface RenderOptions<T> {
  /**
   * Origin of the print Worker, which the browser loads the document, the
   * pack files (`/pack/…`), `/fonts/…` and Paged.js from.
   */
  assetOrigin: string;
  /** Keeps the document and pack files while the tab loads them. */
  store: PrintStore;
  /**
   * Runs on the paginated tab once it is printed and passed every check, in
   * print media at the PDF's page width: the layout the PDF shows.
   */
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
 *
 * Also returns `loaded`, which resolves once no request the tab sent is
 * still loading, and `started`, how many it has sent: print media makes a
 * page load what its print-only CSS uses (T07-20).
 */
async function blockOtherRequests(
  page: Page,
  origin: string,
  files: PublishedFiles,
  onBlocked: (url: string) => void,
): Promise<{
  settle: () => Promise<void>;
  loaded: () => Promise<void>;
  started: () => number;
}> {
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
  const loading = new Set<string>();
  let started = 0;
  let onIdle = () => {};
  cdp.on('Network.requestWillBeSent', event => {
    started++;
    loading.add(event.requestId);
  });
  const done = ({ requestId }: { requestId: string }) => {
    loading.delete(requestId);
    if (loading.size === 0) onIdle();
  };
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', done);
  await cdp.send('Network.enable');
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return {
    settle: async () => {
      while (answering.size > 0) await Promise.all(answering);
    },
    loaded: () =>
      loading.size === 0
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            onIdle = resolve;
          }),
    started: () => started,
  };
}

// How long a failed print waits for its tab's requests before choosing its
// error; a request still loading after that is not waited for.
const settleRequestsMs = 1000;

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
    const requests = await blockOtherRequests(
      page,
      options.assetOrigin,
      files,
      url => {
        blocked.add(url);
        stop(blockedError());
      },
    );
    settle = requests.settle;
    const printing = print(page, files.documentUrl, options, requests);
    printing.catch(() => undefined);
    const result = await Promise.race([printing, stopped]).catch(
      async (error: unknown) => {
        // A check can fail as a blocked request is still on its way to the
        // session: an SVG <set> sends its request as the page becomes ready
        // (T07-24). Waiting for what the tab sent lets request_blocked win.
        if (blocked.size === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            requests.loaded(),
            new Promise<void>(resolve => {
              timer = setTimeout(resolve, settleRequestsMs);
            }),
          ]);
          clearTimeout(timer);
        }
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

// What depends on the viewport but doesn't show in the data-gt boxes that
// `rejectViewportBoxes` compares (T07-20).
function rejectViewportDependent(found: string[] | undefined) {
  if (found && found.length > 0) {
    throw new RenderError(
      'viewport_dependent',
      "The template's CSS depends on the viewport size",
      found,
    );
  }
}

// The PDF and the ground truth would each catch it at a different moment.
function rejectAnimations(animations: string[] | undefined) {
  if (animations && animations.length > 0) {
    throw new RenderError(
      'css_animation',
      'The template animates: CSS animations or transitions, SVG animation or <marquee>',
      animations,
    );
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

// Box entries in one list and not the other, for `layout_unsettled`.
function changedBoxes(before: string[], after: string[]): string[] {
  const missing = (from: string[], other: string[]) => {
    const rest = [...other];
    return from.filter(box => {
      const at = rest.indexOf(box);
      if (at < 0) return true;
      rest.splice(at, 1);
      return false;
    });
  };
  return [
    ...missing(before, after).map(box => `before printing: ${box}`),
    ...missing(after, before).map(box => `after printing: ${box}`),
  ];
}

type Viewport = { width: number; height: number };
const size = ({ width, height }: Viewport) => `${width}x${height}`;

// The boxes of the elements in the pages at two viewports, as `{ boxes }`
// from the runtime (no array: nothing to compare), entry by entry. Chrome
// prints at the exact page size, between its floor and ceil in CSS px, and
// Paged.js breaks pages where the layout at its own viewport put them: a
// layout that differs between two of these can print differently than
// gt.json describes it (T07-22).
function rejectViewportBoxes(
  medium: string,
  a: { viewport: Viewport; boxes?: unknown },
  b: { viewport: Viewport; boxes?: unknown },
) {
  const [from, to] = [a.boxes, b.boxes];
  if (!Array.isArray(from) || !Array.isArray(to)) return;
  const changed: string[] = [];
  for (let i = 0; i < Math.max(from.length, to.length); i++) {
    if (from[i] !== to[i]) {
      changed.push(
        `at ${size(a.viewport)}: ${from[i] ?? 'none'}; at ${size(b.viewport)}: ${to[i] ?? 'none'}`,
      );
    }
  }
  if (changed.length > 0) {
    throw new RenderError(
      'viewport_dependent',
      'The data-gt boxes depend on the viewport size',
      changed
        .slice(0, 50)
        .map(
          box =>
            `${medium}, ${size(a.viewport)} vs ${size(b.viewport)}: ${box}`,
        ),
    );
  }
}

type PrintedReader = {
  __pdfgen: {
    loadPrintResources(): Promise<void>;
    printed(options: { pageWidth: number }): Promise<PrintedState>;
    boxes(pageWidth?: number): {
      boxes: string[];
      viewportDependent: string[];
      animations: string[];
      movedBoxes?: string[];
    };
  };
};

async function print<T>(
  page: Page,
  documentUrl: string,
  options: RenderOptions<T>,
  requests: { loaded: () => Promise<void>; started: () => number },
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
  rejectAnimations(ready.animations);
  rejectViewportDependent(ready.viewportDependent);
  // Ground truth is read relative to each page's box, so a page box a
  // template moved misplaces every block in it (T07-18).
  rejectMovedBoxes(ready.movedBoxes);
  // Everything after this is measured as printed, on the same tab (T03
  // Must 3): Paged.js leaves stylesheets that apply in one medium only live,
  // so the screen can place boxes and data-gt content where the PDF doesn't
  // (T07-20), and its own @media print rules apply only in print media. The
  // viewport as large as the largest page (in CSS px), as when printing: a
  // document wider than its page is shrunk to fit, which moves every box.
  // Print media is in place before the PDF is printed, and what it makes
  // the page load (print-only images and fonts) has loaded.
  let viewport: Viewport = { width: 0, height: 0 };
  const setViewport = async (next: Viewport) => {
    if (next.width === viewport.width && next.height === viewport.height) {
      return;
    }
    viewport = next;
    await page.setViewport(next);
  };
  const floor = (width: number, height: number) => ({
    width: Math.floor(width),
    height: Math.floor(height),
  });
  // With the page width, in print media, the page boxes are checked too.
  const readBoxes = (pageWidth?: number) =>
    page.evaluate(
      width => (globalThis as unknown as PrintedReader).__pdfgen.boxes(width),
      pageWidth,
    );
  // Waits for what the medium or viewport makes the page load and lay out
  // (a `sizes` image switches after a frame), until a round starts no
  // request: what one load lays out can ask for the next (an @import'ed
  // sheet's images).
  const loadResources = () =>
    withinTimeout(
      (async () => {
        for (;;) {
          const started = requests.started();
          await page.evaluate(() =>
            (
              globalThis as unknown as PrintedReader
            ).__pdfgen.loadPrintResources(),
          );
          await requests.loaded();
          if (requests.started() === started) return;
        }
      })(),
      options.timeoutMs ?? defaultTimeoutMs,
      () =>
        new RenderError(
          'layout_unsettled',
          'What print media loads did not finish loading',
        ),
    );
  const paginated = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  const pageViewport = ready.pageSize
    ? floor(ready.pageSize.width, ready.pageSize.height)
    : undefined;
  if (pageViewport) {
    await setViewport(pageViewport);
    await loadResources();
    rejectViewportBoxes(
      'screen media at the pagination viewport',
      { viewport: paginated, boxes: ready.boxes },
      { viewport: pageViewport, ...(await readBoxes()) },
    );
  }
  await page.emulateMediaType('print');
  await loadResources();
  const readPrinted = (pageWidth: number) =>
    page.evaluate(
      width =>
        (globalThis as unknown as PrintedReader).__pdfgen.printed({
          pageWidth: width,
        }),
      pageWidth,
    );
  const before = await readPrinted(ready.pageSize?.width ?? 0);
  // An animation short enough to end while the PDF is printed is gone from
  // the read after it.
  rejectAnimations(before.animations);
  rejectViewportDependent(before.viewportDependent);
  // The same in print media at the other corners of the CSS px around the
  // page size, with what each loads: Chrome prints inside it, and what
  // depends on the width or height only through thresholds or monotonic
  // functions (aspect ratio among them, rising with one and falling with
  // the other) can't differ there from all four corners. What the boxes
  // don't show (fixed pseudo-elements, animations, the page boxes they are
  // measured from) is checked there too.
  if (ready.pageSize && pageViewport) {
    const ceil = {
      width: Math.ceil(ready.pageSize.width),
      height: Math.ceil(ready.pageSize.height),
    };
    const corners = [
      ceil,
      { width: ceil.width, height: pageViewport.height },
      { width: pageViewport.width, height: ceil.height },
    ].filter(
      (corner, i, all) =>
        (corner.width !== pageViewport.width ||
          corner.height !== pageViewport.height) &&
        all.findIndex(
          other =>
            other.width === corner.width && other.height === corner.height,
        ) === i,
    );
    if (corners.length > 0) {
      const atFloor = await readBoxes(ready.pageSize.width);
      for (const corner of corners) {
        await setViewport(corner);
        await loadResources();
        const atCorner = await readBoxes(ready.pageSize.width);
        rejectViewportBoxes(
          'print media',
          { viewport: pageViewport, ...atFloor },
          { viewport: corner, ...atCorner },
        );
        rejectAnimations(atCorner.animations);
        rejectViewportDependent(atCorner.viewportDependent);
        // Page boxes moved at the floor too are refused after printing,
        // where a sheet they add counts first (T08-1).
        rejectMovedBoxes(
          atCorner.movedBoxes?.filter(
            box => !atFloor.movedBoxes?.includes(box),
          ),
        );
      }
      await setViewport(pageViewport);
    }
  }
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  // The PDF is the authority on what was printed (T03 Must 4, PDF part).
  // Content Paged.js didn't lay out (a pack's own pagedjs-content template
  // leaves the rest of <body> live) or CSS on its page boxes can add sheets
  // that no gt.json page describes (T08-1).
  const printedPdf = await getDocumentProxy(new Uint8Array(pdf));
  const { numPages } = printedPdf;
  if (numPages !== ready.pageCount) {
    throw new RenderError(
      'page_count_mismatch',
      'The PDF has a different number of pages than Paged.js made',
      [`PDF pages: ${numPages}; Paged.js pages: ${ready.pageCount}`],
    );
  }
  let pageWidth = 0;
  let pageHeight = 0;
  for (let number = 1; number <= numPages; number++) {
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = (await printedPdf.getPage(number))
      .view;
    pageWidth = Math.max(pageWidth, (x1 - x0) / 0.75);
    pageHeight = Math.max(pageHeight, (y1 - y0) / 0.75);
  }
  await setViewport(floor(pageWidth, pageHeight));
  const printed = await readPrinted(pageWidth);
  // What arrived while the PDF was printed moved boxes after it: the PDF
  // and the ground truth would describe different layouts.
  if (before.boxes && printed.boxes) {
    const changed = changedBoxes(before.boxes, printed.boxes);
    if (changed.length > 0) {
      throw new RenderError(
        'layout_unsettled',
        'The layout changed while the PDF was printed',
        changed.slice(0, 50),
      );
    }
  }
  if (printed.unloadedFaces && printed.unloadedFaces.length > 0) {
    throw new RenderError(
      'font_not_loaded',
      'Some font faces did not load',
      printed.unloadedFaces,
    );
  }
  rejectAnimations(printed.animations);
  if (printed.fragmentedRows && printed.fragmentedRows.length > 0) {
    throw new RenderError(
      'row_fragmented',
      'Some table rows are split or outside their page',
      printed.fragmentedRows,
    );
  }
  // Paged.js broke the pages on screen: what grows only in print reaches past
  // the page it was given, and the PDF clips it or leaves it out (T07-23).
  // Moved page boxes move the content area too, and are refused below.
  if (
    printed.outsidePages &&
    printed.outsidePages.length > 0 &&
    !printed.movedBoxes?.length
  ) {
    throw new RenderError(
      'print_overflow',
      'Content reaches outside its page only in print, where Paged.js did not paginate',
      printed.outsidePages,
    );
  }
  // gt.json describes the whole box and text of what an ancestor clips, the
  // PDF only the part it shows (T07-25). Moved page boxes are refused below.
  if (
    printed.clippedContent &&
    printed.clippedContent.length > 0 &&
    !printed.movedBoxes?.length
  ) {
    throw new RenderError(
      'content_clipped',
      'Some data-gt content is clipped by an ancestor',
      printed.clippedContent,
    );
  }
  if (
    printed.expectedText?.some(blocks =>
      blocks.some(block => block.texts.length > 0),
    )
  ) {
    const missing = await missingText(pdf, printed.expectedText);
    if (missing.length > 0) {
      throw new RenderError(
        'text_missing',
        'Some data-gt text is missing from the PDF',
        missing,
      );
    }
  }
  rejectMovedBoxes(printed.movedBoxes);
  rejectMovedBoxes(await scaledPages(printedPdf, printed.plainInk));
  const inspected = options.inspect ? await options.inspect(page) : undefined;
  return { pdf, pageCount: ready.pageCount, inspected };
}
