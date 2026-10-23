import type { GroundTruth } from '@pdf-generator/contract';
import { type BuildOptions, buildGroundTruth } from './build.ts';
import type { MeasuredElement, Measurement, Region } from './measurement.ts';

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
 */
export async function readGroundTruth(
  page: EvaluatingPage,
  source: GroundTruth['source'],
  options: BuildOptions = {},
): Promise<GroundTruth> {
  const measurement = (await page.evaluate(collectExpression)) as Measurement;
  return buildGroundTruth(measurement, source, options);
}

/**
 * Runs in the browser, so it must stay self-contained: no imports and no
 * references to anything outside its own body. It also declares no named
 * local functions: esbuild's keepNames (on in wrangler) wraps those in a
 * helper that exists only in the bundle, under a name minify changes.
 */
function collect(): Measurement {
  const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
  const regions: [string, Region][] = [
    [
      '.pagedjs_margin-top, .pagedjs_margin-top-left-corner-holder, .pagedjs_margin-top-right-corner-holder',
      'top',
    ],
    [
      '.pagedjs_margin-bottom, .pagedjs_margin-bottom-left-corner-holder, .pagedjs_margin-bottom-right-corner-holder',
      'bottom',
    ],
    ['.pagedjs_margin-left', 'left'],
    ['.pagedjs_margin-right', 'right'],
  ];
  const elements = Array.from(document.querySelectorAll('[data-gt]'))
    // Not laid out (display: none), e.g. the original of a running element.
    .filter(element => element.getClientRects().length > 0)
    .map((element): MeasuredElement => {
      const pageElement = element.closest('.pagedjs_page');
      const { x, y, width, height } = element.getBoundingClientRect();
      return {
        type: element.getAttribute('data-gt') ?? '',
        id: element.getAttribute('data-gt-id'),
        ref: element.getAttribute('data-ref'),
        splitFrom: element.getAttribute('data-split-from'),
        page: pageElement === null ? -1 : pages.indexOf(pageElement),
        region:
          regions.find(([selector]) => element.closest(selector))?.[1] ??
          'area',
        rect: { x, y, width, height },
        text: element instanceof HTMLElement ? element.innerText : '',
        nested: element.parentElement?.closest('[data-gt]') != null,
      };
    });
  // Paged.js puts the declared page size on :root as `--pagedjs-width` and
  // `--pagedjs-height` (one size per document in 0.4.3). Anything but a plain
  // length (e.g. a calc() with bleed) falls back to the measured box.
  const pxPer: Record<string, number> = {
    px: 1,
    pt: 4 / 3,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
  };
  const root = getComputedStyle(document.documentElement);
  const [declaredWidth, declaredHeight] = [
    '--pagedjs-width',
    '--pagedjs-height',
  ].map(name => {
    const match = /^([\d.]+)(px|pt|pc|in|cm|mm|q)$/i.exec(
      root.getPropertyValue(name).trim(),
    );
    const factor = match ? pxPer[match[2]?.toLowerCase() ?? ''] : undefined;
    return match && factor ? Number(match[1]) * factor : undefined;
  });
  const size =
    declaredWidth && declaredHeight
      ? { width: declaredWidth, height: declaredHeight }
      : undefined;
  return {
    pages: pages.map(page => {
      const { x, y, width, height } = page.getBoundingClientRect();
      return { x, y, width, height, ...(size && { size }) };
    }),
    elements,
  };
}

const collectExpression = `(${collect.toString()})()`;
