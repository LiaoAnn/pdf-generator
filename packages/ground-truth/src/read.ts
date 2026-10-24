import type { GroundTruth } from '@pdf-generator/contract';
import { type BuildOptions, buildGroundTruth } from './build.ts';
import type {
  ElementDetails,
  MeasuredElement,
  Measurement,
  Region,
} from './measurement.ts';
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

/**
 * Runs in the browser, so it must stay self-contained: no imports and no
 * references to anything outside its own body. It also declares no named
 * local functions: esbuild's keepNames (on in wrangler) wraps those in a
 * helper that exists only in the bundle, under a name minify changes.
 */
function collect(): Measurement {
  // The pages Paged.js generated: the `.pagedjs_page` children of the last
  // `.pagedjs_pages` child of <body>. Paged.js moves the pack's body into a
  // <template> and appends its container to <body> last, so a pack's own use
  // of these class names lands inside a real page, on <html> or <body>, or
  // (with a pack-supplied pagedjs-content template) in an earlier body child.
  const container = Array.from(document.body?.children ?? [])
    .filter(child => child.classList.contains('pagedjs_pages'))
    .at(-1);
  const pages = Array.from(container?.children ?? []).filter(child =>
    child.classList.contains('pagedjs_page'),
  );
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
      // Real pages never nest, so at most one contains the element.
      const pageElement = pages.find(page => page.contains(element)) ?? null;
      const { x, y, width, height } = element.getBoundingClientRect();
      const origin = pageElement?.getBoundingClientRect() ?? {
        x: 0,
        y: 0,
        right: 0,
        bottom: 0,
      };
      const type = element.getAttribute('data-gt') ?? '';
      const details: ElementDetails | undefined =
        type === 'checkbox'
          ? {
              inputs: [
                element,
                ...Array.from(element.querySelectorAll('input')),
              ]
                .filter(
                  input =>
                    input instanceof HTMLInputElement &&
                    (input.type === 'checkbox' || input.type === 'radio'),
                )
                .map(input => (input as HTMLInputElement).checked),
            }
          : type === 'formula'
            ? {
                annotations: Array.from(
                  element.querySelectorAll(
                    'annotation[encoding="application/x-tex"]',
                  ),
                ).map(annotation => annotation.textContent ?? ''),
                visibleParts: Array.from(
                  element.querySelectorAll('.katex-html'),
                ).map(part => (part as HTMLElement).innerText),
              }
            : type === 'table' && element instanceof HTMLTableElement
              ? {
                  table: {
                    rows: Array.from(element.rows)
                      // Not laid out (display: none): not printed.
                      .filter(row => row.getClientRects().length > 0)
                      .map((row, _, printed) => ({
                        // Rows in the same thead, tbody or tfoot share one.
                        group: printed.findIndex(
                          other => other.parentElement === row.parentElement,
                        ),
                        cells: Array.from(row.cells)
                          .filter(cell => cell.getClientRects().length > 0)
                          .map(cell => {
                            const box = cell.getBoundingClientRect();
                            // Printed checkboxes: marked elements, and
                            // checkbox or radio inputs outside them.
                            const marks = Array.from(
                              cell.querySelectorAll('[data-gt-checked], input'),
                            ).filter(
                              mark =>
                                (mark.hasAttribute('data-gt-checked') ||
                                  (mark instanceof HTMLInputElement &&
                                    (mark.type === 'checkbox' ||
                                      mark.type === 'radio') &&
                                    mark.parentElement?.closest(
                                      '[data-gt-checked]',
                                    ) == null)) &&
                                mark.getClientRects().length > 0,
                            );
                            // Text nodes, and a line break for each <br>
                            // and block box, each with the node whose
                            // layout decides whether it is printed.
                            const walker = document.createTreeWalker(
                              cell,
                              NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
                            );
                            const texts: {
                              node: Node;
                              shown: Element | null;
                              text: string;
                            }[] = [];
                            for (
                              let node = walker.nextNode();
                              node !== null;
                              node = walker.nextNode()
                            ) {
                              if (node instanceof Element) {
                                const display = getComputedStyle(node).display;
                                if (
                                  node.tagName === 'BR' ||
                                  !(
                                    display.startsWith('inline') ||
                                    display === 'contents'
                                  )
                                ) {
                                  texts.push({ node, shown: node, text: '\n' });
                                }
                              } else {
                                texts.push({
                                  node,
                                  shown: node.parentElement,
                                  text: node.textContent ?? '',
                                });
                              }
                            }
                            const checkboxes = marks.map((mark, k) => {
                              const next = marks[k + 1];
                              const markBox = mark.getBoundingClientRect();
                              return {
                                declared: mark.getAttribute('data-gt-checked'),
                                inputs: [
                                  mark,
                                  ...Array.from(mark.querySelectorAll('input')),
                                ]
                                  .filter(
                                    input =>
                                      input instanceof HTMLInputElement &&
                                      (input.type === 'checkbox' ||
                                        input.type === 'radio'),
                                  )
                                  .map(
                                    input =>
                                      (input as HTMLInputElement).checked,
                                  ),
                                // Visible text after the mark, up to the next.
                                label: texts
                                  .filter(
                                    ({ node, shown }) =>
                                      !mark.contains(node) &&
                                      (mark.compareDocumentPosition(node) &
                                        Node.DOCUMENT_POSITION_FOLLOWING) !==
                                        0 &&
                                      (next === undefined ||
                                        (next.compareDocumentPosition(node) &
                                          Node.DOCUMENT_POSITION_PRECEDING) !==
                                          0) &&
                                      (shown?.getClientRects().length ?? 0) > 0,
                                  )
                                  .map(({ text }) => text)
                                  .join(''),
                                rect: {
                                  x: markBox.x - origin.x,
                                  y: markBox.y - origin.y,
                                  width: markBox.width,
                                  height: markBox.height,
                                },
                              };
                            });
                            return {
                              ...(checkboxes.length > 0 && { checkboxes }),
                              rowSpan: cell.rowSpan,
                              colSpan: cell.colSpan,
                              header:
                                cell.tagName === 'TH' ||
                                row.parentElement?.tagName === 'THEAD',
                              text: cell.innerText,
                              rect: {
                                x: box.x - origin.x,
                                y: box.y - origin.y,
                                width: box.width,
                                height: box.height,
                              },
                              // Half a px of slack for subpixel layout.
                              printed:
                                cell.getClientRects().length === 1 &&
                                box.x >= origin.x - 0.5 &&
                                box.y >= origin.y - 0.5 &&
                                box.right <= origin.right + 0.5 &&
                                box.bottom <= origin.bottom + 0.5,
                            };
                          }),
                      })),
                  },
                }
              : undefined;
      return {
        type,
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
        attributes: Object.fromEntries(
          Array.from(element.attributes)
            .filter(
              ({ name }) =>
                name.startsWith('data-gt-') && name !== 'data-gt-id',
            )
            .map(({ name, value }) => [name, value]),
        ),
        innerAttributes: Array.from(element.querySelectorAll('*')).flatMap(
          inner =>
            Array.from(inner.attributes)
              .filter(
                ({ name }) =>
                  name.startsWith('data-gt-') &&
                  // A checkbox inside one of this table's cells (T02-2).
                  !(
                    name === 'data-gt-checked' &&
                    inner.parentElement?.closest('td, th')?.closest('table') ===
                      element
                  ) &&
                  // A slot the print runtime filled with a page number (T02-5).
                  !(
                    (name === 'data-gt-page-number' ||
                      name === 'data-gt-page-count') &&
                    element.getAttribute('data-gt') === 'page_number'
                  ),
              )
              .map(({ name }) => ({ tag: inner.tagName.toLowerCase(), name })),
        ),
        ...(details && { details }),
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
