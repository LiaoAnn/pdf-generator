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
 * @returns {Promise<Measurement>}
 */
export async function collect() {
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
  // print runtime's hiddenCopies() and inkInBox() decide: text in a MathML
  // element inside a .katex-mathml element, not itself marked data-gt, of
  // which at most 1px shows (IntersectionObserver rooted at <html>), whose
  // ink stays within that box, and that lies across within the box. The PDF
  // doesn't print it, so block and cell texts leave it out (at the end).
  /** @type {Map<Element, Text[]>} */
  const copyTexts = new Map();
  /** Every text node in each .katex-mathml element. @type {Map<Element, Text[]>} */
  const wrapperTexts = new Map();
  const textWalker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  for (
    let node = textWalker.nextNode();
    node !== null;
    node = textWalker.nextNode()
  ) {
    const parent = node.parentElement;
    const wrapper = parent?.closest('.katex-mathml');
    if (!parent || !wrapper) continue;
    const inWrapper = wrapperTexts.get(wrapper) ?? [];
    inWrapper.push(/** @type {Text} */ (node));
    wrapperTexts.set(wrapper, inWrapper);
    if (
      parent.namespaceURI !== 'http://www.w3.org/1998/Math/MathML' ||
      parent.hasAttribute('data-gt')
    ) {
      continue;
    }
    const inParent = copyTexts.get(parent) ?? [];
    inParent.push(/** @type {Text} */ (node));
    copyTexts.set(parent, inParent);
  }
  /** @type {Map<Element, IntersectionObserverEntry>} */
  const shown = new Map();
  if (copyTexts.size > 0) {
    // Reported at the next rendering update; one that isn't within the time
    // limit counts as shown.
    await new Promise(resolve => {
      const observer = new IntersectionObserver(
        entries => {
          for (const entry of entries) shown.set(entry.target, entry);
          if (shown.size >= copyTexts.size) {
            observer.disconnect();
            resolve(undefined);
          }
        },
        // Without the margin, boxes on later pages read as clipped entirely
        // (<html>'s box doesn't reach them in print media).
        { root: document.documentElement, rootMargin: '1000000px' },
      );
      for (const element of copyTexts.keys()) observer.observe(element);
      setTimeout(() => {
        observer.disconnect();
        resolve(undefined);
      }, 2000);
    });
  }
  /** Ancestors already checked for paint that leaves the box. @type {Map<Element, boolean>} */
  const plain = new Map();
  const hiddenTexts = new Set(
    Array.from(copyTexts).flatMap(([element, nodes]) => {
      const entry = shown.get(element);
      const style = getComputedStyle(element);
      const sizes = element.computedStyleMap();
      if (
        !entry ||
        (entry.isIntersecting &&
          (entry.intersectionRect.width > 1 ||
            entry.intersectionRect.height > 1)) ||
        // Laid out as MathML (token boxes as tall as their ink), with no
        // CSS size, negative spacing or vertical writing.
        !style.display.endsWith('math') ||
        ['width', 'height', 'min-width', 'min-height'].some(
          name => String(sizes.get(name)) !== 'auto',
        ) ||
        ['max-width', 'max-height'].some(
          name => String(sizes.get(name)) !== 'none',
        ) ||
        style.writingMode !== 'horizontal-tb' ||
        Number.parseFloat(style.letterSpacing) < 0 ||
        Number.parseFloat(style.wordSpacing) < 0
      ) {
        return [];
      }
      // Drawn nowhere else: no shadow, stroke or emphasis mark (also from
      // ::first-line or ::first-letter), no filter or reflection on it or an
      // ancestor.
      for (
        let at = /** @type {Element | null} */ (element);
        at !== null;
        at = at.parentElement
      ) {
        let ok = plain.get(at);
        if (ok === undefined) {
          const own = getComputedStyle(at);
          const ancestor = at;
          ok =
            own.filter === 'none' &&
            own.getPropertyValue('-webkit-box-reflect') === 'none' &&
            [
              own,
              ...['::first-line', '::first-letter'].map(pseudo =>
                getComputedStyle(ancestor, pseudo),
              ),
            ].every(
              text =>
                text.textShadow === 'none' &&
                text.getPropertyValue('-webkit-text-stroke-width') === '0px' &&
                text.getPropertyValue('text-emphasis-style') === 'none',
            );
          plain.set(at, ok);
        }
        if (!ok) return [];
      }
      const box = entry.boundingClientRect;
      return nodes.filter(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        return (
          rects.length > 0 &&
          rects.every(
            rect => rect.left >= box.left - 1 && rect.right <= box.right + 1,
          )
        );
      });
    }),
  );
  // The HTML .katex-mathml elements whose rendered text is all hidden copy,
  // left out of block and cell texts whole (so that their box adds no line
  // break to innerText either). Not one marked data-gt or holding a data-gt
  // element or a table cell: their own text is read.
  const copyWrappers = Array.from(wrapperTexts)
    .filter(
      ([wrapper, nodes]) =>
        wrapper instanceof HTMLElement &&
        !wrapper.matches('[data-gt]') &&
        wrapper.querySelector('[data-gt], td, th') === null &&
        nodes.some(node => hiddenTexts.has(node)) &&
        nodes.every(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return (
            hiddenTexts.has(node) ||
            node.data.trim() === '' ||
            range.getClientRects().length === 0
          );
        }),
    )
    .map(([wrapper]) => /** @type {HTMLElement} */ (wrapper));
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
  // with it left out (an inline display: none on its .katex-mathml element)
  // once everything is measured, and put back. Pack CSS can react to that
  // edit (a [style] selector, :has()), so the new text is taken only if it is
  // the text read before with exactly the copies' text taken out, in order
  // (whitespace aside). Otherwise the text read before stays, copy and all,
  // for the self-check to report.
  const owners = textOwners.filter(([owner]) =>
    copyWrappers.some(wrapper => owner.contains(wrapper)),
  );
  if (owners.length > 0) {
    const copies = copyWrappers.map(wrapper =>
      wrapper.innerText.replace(/\s/g, ''),
    );
    const styles = copyWrappers.map(wrapper => wrapper.getAttribute('style'));
    /** @type {string[]} */
    let reread = [];
    try {
      for (const wrapper of copyWrappers) {
        wrapper.style.setProperty('display', 'none', 'important');
      }
      reread = owners.map(([owner]) =>
        owner instanceof HTMLElement ? owner.innerText : '',
      );
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
      const text = reread[index] ?? '';
      const without = text.replace(/\s/g, '');
      const full = measured.text.replace(/\s/g, '');
      const blocks = copyWrappers.flatMap((wrapper, k) =>
        owner.contains(wrapper) ? [copies[k] ?? ''] : [],
      );
      // Where the k-th copy starts if j characters of the new text came first.
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
