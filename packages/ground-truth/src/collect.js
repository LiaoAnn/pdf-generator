// The in-browser collector of readGroundTruth. Plain JavaScript with JSDoc
// types, checked by this package's own tsconfig (DOM lib, checkJs): callers
// see only collect.d.ts, so their programs need no DOM lib.
/** @import { ElementDetails, MeasuredElement, Measurement, Region } from './measurement.ts' */

/**
 * Runs in the browser, so it must stay self-contained: no imports and no
 * references to anything outside its own body. It also declares no named
 * local functions: esbuild's keepNames (on in wrangler) wraps those in a
 * helper that exists only in the bundle, under a name minify changes.
 *
 * @returns {Measurement}
 */
export function collect() {
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
  /** @type {[string, Region][]} */
  const regions = [
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
  // KaTeX's MathML copy of a formula that the browser hides (T07-26), as the
  // print runtime's hiddenCopies() decides: a .katex-mathml element that
  // clips all of its content to at most 1x1 px (absolutely positioned, one
  // block box no larger than 1x1 px as shown, overflow hidden or clip on both
  // axes with no clip margin, nothing in it fixed-positioned), all of whose
  // rendered text is in MathML elements not marked data-gt. The PDF doesn't
  // print it, so block and cell texts leave it out (at the end). Not one
  // marked data-gt or holding a data-gt element or a table cell: their own
  // text is read.
  const copyWrappers = Array.from(document.querySelectorAll('.katex-mathml'))
    .filter(wrapper => {
      const style = getComputedStyle(wrapper);
      const box = wrapper.getBoundingClientRect();
      if (
        !(wrapper instanceof HTMLElement) ||
        wrapper.matches('[data-gt]') ||
        wrapper.querySelector('[data-gt], td, th') !== null ||
        style.position !== 'absolute' ||
        !(style.display === 'block' || style.display === 'flow-root') ||
        !['hidden', 'clip'].includes(style.overflowX) ||
        !['hidden', 'clip'].includes(style.overflowY) ||
        style.getPropertyValue('overflow-clip-margin') !== '0px' ||
        wrapper.getClientRects().length !== 1 ||
        box.width > 1 ||
        box.height > 1 ||
        Array.from(wrapper.querySelectorAll('*')).some(
          inner => getComputedStyle(inner).position === 'fixed',
        )
      ) {
        return false;
      }
      const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
      let copy = false;
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        const parent = node.parentElement;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (
          parent?.namespaceURI === 'http://www.w3.org/1998/Math/MathML' &&
          !parent.hasAttribute('data-gt')
        ) {
          copy = true;
        } else if (
          (node.textContent ?? '').trim() !== '' &&
          range.getClientRects().length > 0
        ) {
          return false;
        }
      }
      return copy;
    })
    .map(wrapper => /** @type {HTMLElement} */ (wrapper));
  /** Measured blocks and cells, with the element whose text they hold. @type {[Element, { text: string }][]} */
  const textOwners = [];
  const elements = Array.from(document.querySelectorAll('[data-gt]'))
    // Not laid out (display: none), e.g. the original of a running element.
    .filter(element => element.getClientRects().length > 0)
    .map(
      /** @returns {MeasuredElement} */
      element => {
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
        /** @type {ElementDetails | undefined} */
        const details =
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
                  .map(
                    input => /** @type {HTMLInputElement} */ (input).checked,
                  ),
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
                  ).map(part => /** @type {HTMLElement} */ (part).innerText),
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
                                cell.querySelectorAll(
                                  '[data-gt-checked], input',
                                ),
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
                              /** @type {{ node: Node; shown: Element | null; text: string; }[]} */
                              const texts = [];
                              for (
                                let node = walker.nextNode();
                                node !== null;
                                node = walker.nextNode()
                              ) {
                                // KaTeX's hidden MathML copy, as above.
                                if (
                                  copyWrappers.some(wrapper =>
                                    wrapper.contains(node),
                                  )
                                ) {
                                  continue;
                                }
                                if (node instanceof Element) {
                                  const display =
                                    getComputedStyle(node).display;
                                  if (
                                    node.tagName === 'BR' ||
                                    !(
                                      display.startsWith('inline') ||
                                      display === 'contents'
                                    )
                                  ) {
                                    texts.push({
                                      node,
                                      shown: node,
                                      text: '\n',
                                    });
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
                                  declared:
                                    mark.getAttribute('data-gt-checked'),
                                  inputs: [
                                    mark,
                                    ...Array.from(
                                      mark.querySelectorAll('input'),
                                    ),
                                  ]
                                    .filter(
                                      input =>
                                        input instanceof HTMLInputElement &&
                                        (input.type === 'checkbox' ||
                                          input.type === 'radio'),
                                    )
                                    .map(
                                      input =>
                                        /** @type {HTMLInputElement} */ (input)
                                          .checked,
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
                                        (shown?.getClientRects().length ?? 0) >
                                          0,
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
                              const measuredCell = {
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
                              textOwners.push([cell, measuredCell]);
                              return measuredCell;
                            }),
                        })),
                    },
                  }
                : undefined;
        const measured = {
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
                      inner.parentElement
                        ?.closest('td, th')
                        ?.closest('table') === element
                    ) &&
                    // A slot the print runtime filled with a page number (T02-5).
                    !(
                      (name === 'data-gt-page-number' ||
                        name === 'data-gt-page-count') &&
                      element.getAttribute('data-gt') === 'page_number'
                    ),
                )
                .map(({ name }) => ({
                  tag: inner.tagName.toLowerCase(),
                  name,
                })),
          ),
          ...(details && { details }),
        };
        textOwners.push([element, measured]);
        return measured;
      },
    );
  // Paged.js puts the declared page size on :root as `--pagedjs-width` and
  // `--pagedjs-height` (one size per document in 0.4.3). Anything but a plain
  // length (e.g. a calc() with bleed) falls back to the measured box.
  /** @type {Record<string, number>} */
  const pxPer = {
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
  const measuredPages = pages.map(page => {
    const { x, y, width, height } = page.getBoundingClientRect();
    return { x, y, width, height, ...(size && { size }) };
  });
  // The text of blocks and cells with KaTeX's hidden copy in them, read again
  // with the copy left out (an inline display: none on its .katex-mathml
  // element) once everything is measured, and put back. Pack CSS can react to
  // that edit (a [style] selector, :has()), so the new text is taken only if
  // nothing else innerText reads changed (each element's display, visibility,
  // text-transform, white-space and content-visibility, outside the copies)
  // and it is the text read before with exactly the copies' text taken out,
  // in order (whitespace aside). Otherwise the text read before stays, copy
  // and all, for the self-check to report.
  const owners = textOwners.filter(([owner]) =>
    copyWrappers.some(wrapper => owner.contains(wrapper)),
  );
  if (owners.length > 0) {
    const copies = copyWrappers.map(wrapper =>
      wrapper.innerText.replace(/\s/g, ''),
    );
    const read = owners.map(([owner]) =>
      [owner, ...Array.from(owner.querySelectorAll('*'))].filter(
        element => !copyWrappers.some(wrapper => wrapper.contains(element)),
      ),
    );
    const styles = copyWrappers.map(wrapper => wrapper.getAttribute('style'));
    /** @type {string[][]} */
    const looks = [];
    /** @type {string[]} */
    let reread = [];
    try {
      for (const phase of ['before', 'during']) {
        if (phase === 'during') {
          for (const wrapper of copyWrappers) {
            wrapper.style.setProperty('display', 'none', 'important');
          }
          reread = owners.map(([owner]) =>
            owner instanceof HTMLElement ? owner.innerText : '',
          );
        }
        looks.push(
          read.map(elements =>
            elements
              .map(element => {
                const style = getComputedStyle(element);
                return [
                  style.display,
                  style.visibility,
                  style.textTransform,
                  style.whiteSpace,
                  style.contentVisibility,
                ].join(' ');
              })
              .join('\n'),
          ),
        );
      }
    } finally {
      copyWrappers.forEach((wrapper, index) => {
        const style = styles[index];
        if (style === null || style === undefined) {
          wrapper.removeAttribute('style');
        } else {
          wrapper.setAttribute('style', style);
        }
      });
    }
    owners.forEach(([owner, measured], index) => {
      if (looks[0]?.[index] !== looks[1]?.[index]) return;
      const text = reread[index] ?? '';
      const without = text.replace(/\s/g, '');
      const full = measured.text.replace(/\s/g, '');
      const blocks = copyWrappers.flatMap((wrapper, k) =>
        owner.contains(wrapper) ? [copies[k] ?? ''] : [],
      );
      // Where the k-th copy starts in the text read before, after j
      // characters of the new text.
      const before = [0];
      for (const block of blocks) {
        before.push((before.at(-1) ?? 0) + block.length);
      }
      // States [j, k]: j characters of the new text and k copies make up the
      // start of the text read before.
      let states = [[0, 0]];
      const visited = new Set(['0,0']);
      let matched = false;
      while (!matched && states.length > 0) {
        /** @type {number[][]} */
        const next = [];
        for (const [j = 0, k = 0] of states) {
          const at = j + (before[k] ?? 0);
          if (j === without.length && k === blocks.length) {
            matched = at === full.length;
            if (matched) break;
            continue;
          }
          const steps = [
            ...(j < without.length && full[at] === without[j]
              ? [[j + 1, k]]
              : []),
            ...(k < blocks.length && full.startsWith(blocks[k] ?? '', at)
              ? [[j, k + 1]]
              : []),
          ];
          for (const step of steps) {
            const key = step.join(',');
            if (!visited.has(key)) {
              visited.add(key);
              next.push(step);
            }
          }
        }
        states = next;
      }
      if (matched) measured.text = text;
    });
  }
  return {
    pages: measuredPages,
    elements,
  };
}
