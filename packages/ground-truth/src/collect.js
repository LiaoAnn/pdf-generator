// The in-browser collector of readGroundTruth. Plain JavaScript with JSDoc
// types, checked by this package's own tsconfig (DOM lib, checkJs): callers
// see only collect.d.ts, so their programs need no DOM lib.
/** @import { ElementDetails, MeasuredElement, Measurement, PaintedBox, Rect, Region } from './measurement.ts' */

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
  // T08-4: a ::before or ::after belongs to the element it is generated on,
  // so what it paints counts for that element's block exactly as an
  // element's own would. Pseudo-elements have no DOM geometry, so each one
  // of a laid-out data-gt element or of a laid-out HTML element inside one
  // (not inside an <svg>) that could paint a decoration — a background image
  // or non-transparent color, a visible border side (style not none/hidden,
  // positive width, color not transparent), an outline (styled, wider than
  // 0, not transparent) or a box-shadow — is rebuilt briefly as a real
  // <span>: every property of its computed style copied onto its inline
  // style with priority 'important' (content left out, animations and
  // transitions off) and its decoded text as its content, inserted where the
  // pseudo-element renders (first child for ::before, last for ::after)
  // while one injected <style> hides the real pseudo-elements. If the
  // rebuild moves or repaints anything (a pack rule such as :has() reacting
  // to the span), everything is undone and no pseudo-element is measured at
  // all. The host mark is the first attribute name no element on the page
  // carries, removed afterwards from only the elements it was set on, and
  // the rebuilt spans are known by identity, never by an attribute of the
  // span: reading never adds to, changes or removes an attribute a pack
  // element carries. Either way the rebuild is undone before any text or
  // attribute is read, so the page ends exactly as it was.
  /** @type {Map<Element, PaintedBox[]>} */
  const paintedByElement = new Map();
  /** @type {Element[]} */
  const spans = [];
  /** @type {Set<Element>} */
  const markedHosts = new Set();
  /** @type {HTMLStyleElement | undefined} */
  let hiding;
  // The reader's own mark: the first attribute name no element in the
  // document carries (data-collect-pseudo-host, then -1, -2, …), so marking
  // hosts can never change an attribute a pack element has, however the
  // pack's CSS reacts to attributes.
  let markName = 'data-collect-pseudo-host';
  for (let i = 1; document.querySelector(`[${markName}]`) !== null; i += 1) {
    markName = `data-collect-pseudo-host-${i}`;
  }
  /** The laid-out blocks and everything in them: what rebuilding must not
   * move, and where pseudo-elements can be hosted. */
  /** @type {Element[]} */
  const seen = Array.from(
    new Set(
      Array.from(document.querySelectorAll('[data-gt]'))
        .filter(element => element.getClientRects().length > 0)
        .flatMap(element => [
          element,
          ...Array.from(element.querySelectorAll('*')),
        ]),
    ),
  );
  /** @type {HTMLElement[]} */
  const seenHtml = /** @type {HTMLElement[]} */ (
    seen.filter(element => element instanceof HTMLElement)
  ).filter(
    element =>
      element.parentElement?.closest('svg') == null &&
      element.getClientRects().length > 0,
  );
  // What the rebuild must not change: every seen element's client rects
  // and the computed values that decide what it paints, so any change,
  // layout or paint (through a pack rule such as :has()), rolls the rebuild
  // back.
  const paintedProps = [
    'display',
    'visibility',
    'background-color',
    'background-image',
    'border-top-style',
    'border-top-width',
    'border-top-color',
    'border-right-style',
    'border-right-width',
    'border-right-color',
    'border-bottom-style',
    'border-bottom-width',
    'border-bottom-color',
    'border-left-style',
    'border-left-width',
    'border-left-color',
    'border-collapse',
    'outline-style',
    'outline-width',
    'outline-color',
    'outline-offset',
    'box-shadow',
    'overflow-x',
    'overflow-y',
    'box-decoration-break',
    '-webkit-box-decoration-break',
    'direction',
  ];
  // What the guard compares: the blocks, everything in them and their
  // ancestors (whose overflow clips what the blocks paint).
  /** @type {Element[]} */
  const guarded = Array.from(
    new Set([
      ...seen.flatMap(element => {
        /** @type {Element[]} */
        const ancestors = [];
        for (
          let at = element.parentElement;
          at !== null;
          at = at.parentElement
        ) {
          ancestors.push(at);
        }
        return ancestors;
      }),
      ...seen,
    ]),
  );
  const snapshot = guarded
    .map(element => {
      const style = getComputedStyle(element);
      return [
        ...Array.from(
          element.getClientRects(),
          rect => `${rect.x},${rect.y},${rect.width},${rect.height}`,
        ),
        ...paintedProps.map(name => style.getPropertyValue(name)),
      ].join(';');
    })
    .join('|');
  try {
    /** @type {{ host: HTMLElement; pseudo: string; properties: [string, string][]; text: string }[]} */
    const candidates = [];
    for (const host of seenHtml) {
      for (const pseudo of ['::before', '::after']) {
        const pseudoStyle = getComputedStyle(host, pseudo);
        // Only content that consists solely of CSS strings (one or more
        // "..." parts separated by whitespace) can paint a measurable
        // pseudo-element; anything else (none, normal, counter(), attr(),
        // url(), open/close quotes, / alt text) is left out.
        const content = pseudoStyle.content;
        const strings = Array.from(
          content.matchAll(/"((?:\\.|[^"\\])*)"/g),
          match => match[1] ?? '',
        );
        if (
          strings.length === 0 ||
          content.replace(/"(?:\\.|[^"\\])*"/g, '').trim() !== '' ||
          pseudoStyle.display === 'none' ||
          pseudoStyle.visibility !== 'visible'
        ) {
          continue;
        }
        // alpha of the background color, the four border colors and the
        // outline color: what follows the '/' in the slash color syntax
        // (rgb(0 0 0 / 0), lab(), color()) or rgba()'s fourth part.
        const alpha = [
          pseudoStyle.backgroundColor,
          pseudoStyle.borderTopColor,
          pseudoStyle.borderRightColor,
          pseudoStyle.borderBottomColor,
          pseudoStyle.borderLeftColor,
          pseudoStyle.outlineColor,
        ].map(color => {
          const slash = color.lastIndexOf('/');
          const parts = color.split(',');
          return slash >= 0
            ? Number.parseFloat(color.slice(slash + 1))
            : parts.length === 4
              ? Number.parseFloat(parts[3] ?? '')
              : 1;
        });
        if (
          pseudoStyle.backgroundImage === 'none' &&
          (alpha[0] ?? 0) === 0 &&
          ['top', 'right', 'bottom', 'left'].every(
            (side, index) =>
              ['none', 'hidden'].includes(
                pseudoStyle.getPropertyValue(`border-${side}-style`),
              ) ||
              Number.parseFloat(
                pseudoStyle.getPropertyValue(`border-${side}-width`),
              ) <= 0 ||
              (alpha[index + 1] ?? 0) === 0,
          ) &&
          (pseudoStyle.outlineStyle === 'none' ||
            Number.parseFloat(pseudoStyle.outlineWidth) <= 0 ||
            (alpha[5] ?? 0) === 0) &&
          pseudoStyle.boxShadow === 'none'
        ) {
          continue;
        }
        candidates.push({
          host,
          pseudo,
          properties: Array.from(pseudoStyle, name => [
            /** @type {string} */ (name),
            pseudoStyle.getPropertyValue(name),
          ]),
          // CSS escape decoding: \ followed by 1-6 hex digits and one
          // optional whitespace is that code point; \ followed by any other
          // char is that char.
          text: strings
            .join('')
            .replace(
              /\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g,
              (_whole, hex, char) =>
                hex === undefined
                  ? /** @type {string} */ (char)
                  : String.fromCodePoint(Number.parseInt(hex, 16)),
            ),
        });
      }
    }
    hiding = document.createElement('style');
    hiding.textContent = `[${markName}~="before"]::before, [${markName}~="after"]::after { display: none !important; }`;
    document.head.appendChild(hiding);
    for (const { host, pseudo, properties, text } of candidates) {
      const span = document.createElement('span');
      for (const [name, value] of properties) {
        if (name !== 'content') {
          span.style.setProperty(name, value, 'important');
        }
      }
      span.style.setProperty('animation-name', 'none', 'important');
      span.style.setProperty('transition-property', 'none', 'important');
      span.textContent = text;
      host.setAttribute(
        markName,
        `${host.getAttribute(markName) ?? ''} ${pseudo.slice(2)}`.trim(),
      );
      markedHosts.add(host);
      if (pseudo === '::before') {
        host.insertBefore(span, host.firstChild);
      } else {
        host.appendChild(span);
      }
      spans.push(span);
    }
    if (
      spans.length > 0 &&
      guarded
        .map(element => {
          const style = getComputedStyle(element);
          return [
            ...Array.from(
              element.getClientRects(),
              rect => `${rect.x},${rect.y},${rect.width},${rect.height}`,
            ),
            ...paintedProps.map(name => style.getPropertyValue(name)),
          ].join(';');
        })
        .join('|') !== snapshot
    ) {
      // The rebuild moved or repainted something: undo it wholesale and
      // measure no pseudo-element at all.
      for (const span of spans) span.remove();
      spans.length = 0;
      hiding.remove();
      hiding = undefined;
      for (const host of markedHosts) {
        host.removeAttribute(markName);
      }
      markedHosts.clear();
    }
    // Chrome paints these on whole px of the page; build moves the box onto
    // them. Replaced elements (T08-2): an <svg> inside another one is drawn
    // as part of the outer one. Backgrounds and borders (T08-3): one entry
    // per client rect, so each line fragment of an inline element counts; an
    // element that paints nothing (display: none or contents) contributes
    // none. Outlines and outer box-shadows (T08-4) grow the box instead, and
    // a rebuilt pseudo-element's background or borders count as 'pseudo'
    // entries that carry the overflow clips around it. Document order
    // throughout.
    for (const element of Array.from(
      document.querySelectorAll('[data-gt]'),
    ).filter(element => element.getClientRects().length > 0)) {
      paintedByElement.set(
        element,
        [element, ...Array.from(element.querySelectorAll('*'))].flatMap(
          inner => {
            /** @type {PaintedBox[]} */
            const boxes = [];
            if (
              (inner instanceof HTMLImageElement ||
                (inner instanceof SVGSVGElement &&
                  inner.parentElement?.closest('svg') == null)) &&
              inner.getClientRects().length > 0
            ) {
              const box = inner.getBoundingClientRect();
              boxes.push({
                kind: /** @type {'img' | 'svg'} */ (
                  inner instanceof HTMLImageElement ? 'img' : 'svg'
                ),
                rect: {
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                },
              });
            }
            // A laid-out HTML element with a visible background or border,
            // not inside an <svg>: visibility resolved on it (inherited as
            // computed). The background (an image, or a color with alpha > 0)
            // paints each whole client rect; without one, the painted area is
            // the union of the visible border sides' strips on each client
            // rect, a side being visible when its style is not none/hidden,
            // its width is positive and its color's alpha > 0. alpha is what
            // follows the '/' in the slash color syntax (rgb(0 0 0 / 0),
            // lab(), color()) or rgba()'s fourth part.
            // An outer <svg> (one not inside another <svg>) is a CSS box
            // too: its outline and outer box-shadows paint like an HTML
            // element's (T08-4). It keeps its 'svg' entry above and gets no
            // background or border 'box' entry.
            const outerSvg =
              inner instanceof SVGSVGElement &&
              inner.parentElement?.closest('svg') == null;
            if (
              outerSvg ||
              (inner instanceof HTMLElement &&
                inner.parentElement?.closest('svg') == null)
            ) {
              const style = getComputedStyle(inner);
              const visible = style.visibility === 'visible';
              // alpha of the background color and the four border colors, in
              // top, right, bottom, left order.
              const alpha = [
                style.backgroundColor,
                style.borderTopColor,
                style.borderRightColor,
                style.borderBottomColor,
                style.borderLeftColor,
              ].map(color => {
                const slash = color.lastIndexOf('/');
                const parts = color.split(',');
                return slash >= 0
                  ? Number.parseFloat(color.slice(slash + 1))
                  : parts.length === 4
                    ? Number.parseFloat(parts[3] ?? '')
                    : 1;
              });
              const background =
                !outerSvg &&
                visible &&
                (style.backgroundImage !== 'none' || (alpha[0] ?? 0) > 0);
              // T08-4: an outline paints a ring around each client rect
              // when it is styled (not none), wider than 0, visible and not
              // fully transparent (Chrome reports a width even for style
              // none). offset and width are the computed values, already
              // snapped by Chrome (2.5px → 2px, 3.3px → 3px).
              const outlineWidth = Number.parseFloat(style.outlineWidth);
              const outlineSlash = style.outlineColor.lastIndexOf('/');
              const outlineParts = style.outlineColor.split(',');
              const outlineAlpha =
                outlineSlash >= 0
                  ? Number.parseFloat(
                      style.outlineColor.slice(outlineSlash + 1),
                    )
                  : outlineParts.length === 4
                    ? Number.parseFloat(outlineParts[3] ?? '')
                    : 1;
              const outlines =
                visible &&
                style.outlineStyle !== 'none' &&
                outlineWidth > 0 &&
                outlineAlpha > 0
                  ? {
                      width: outlineWidth,
                      offset: Number.parseFloat(style.outlineOffset),
                    }
                  : undefined;
              // T08-4: outer box-shadows, each a shape painted around every
              // client rect. Chrome serializes the computed box-shadow as a
              // comma-separated list, each shadow `<color> <x>px <y>px
              // <blur>px <spread>px` with ` inset` last; the colour may hold
              // commas (rgba(...)) or spaces (rgb(0 0 0 / 0)), so split on
              // commas and spaces outside parentheses only. Inset and fully
              // transparent shadows (same alpha parsing as borders) paint
              // nothing. Offsets, blur and spread stay unrounded.
              const shadows =
                visible && style.boxShadow !== 'none'
                  ? style.boxShadow
                      .split(/,(?![^(]*\))/)
                      .map(part => {
                        const tokens = part.trim().split(/\s+(?![^(]*\))/);
                        const inset = tokens.includes('inset');
                        const first = tokens.findIndex(token =>
                          /px$/.test(token),
                        );
                        const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] =
                          tokens
                            .slice(first, inset ? -1 : undefined)
                            .map(token => Number.parseFloat(token));
                        const color = tokens.slice(0, first).join(' ');
                        const slash = color.lastIndexOf('/');
                        const parts = color.split(',');
                        const alpha =
                          slash >= 0
                            ? Number.parseFloat(color.slice(slash + 1))
                            : parts.length === 4
                              ? Number.parseFloat(parts[3] ?? '')
                              : 1;
                        return {
                          inset,
                          alpha,
                          offsetX,
                          offsetY,
                          blur,
                          spread,
                        };
                      })
                      .filter(shadow => !shadow.inset && shadow.alpha > 0)
                  : [];
              // An inline element broken over lines is shadowed as one box
              // sliced at the line ends (box-decoration-break: slice, the
              // initial value): a sliced side gets no shadow past it. With
              // direction rtl the sliced sides swap.
              const decoration =
                style.getPropertyValue('box-decoration-break') ||
                style.getPropertyValue('-webkit-box-decoration-break') ||
                'slice';
              const rtl = style.direction === 'rtl';
              // A rebuilt ::before/::after (T08-4), known by identity so no
              // attribute of a pack element can be mistaken for one: its
              // background or borders count like an element's own, but its
              // box may lie outside the block's, so its entries are 'pseudo'
              // and carry the overflow clips around it (its ancestors start
              // at its host, so a host with overflow: hidden clips its own
              // pseudo-elements).
              const pseudo = spans.includes(inner);
              // The rect an outline or shadow of this element — or a rebuilt
              // pseudo-element's box — paints inside: the intersection, over
              // its ancestors up to and including its .pagedjs_page, of each
              // one's padding box on every axis on which its overflow is not
              // visible. Paged.js's .pagedjs_sheet has overflow hidden, so
              // this always covers the page's edges.
              /** @type {Rect | undefined} */
              let clipBox;
              if (outlines !== undefined || shadows.length > 0 || pseudo) {
                let x0 = -Infinity;
                let y0 = -Infinity;
                let x1 = Infinity;
                let y1 = Infinity;
                for (
                  let at = inner.parentElement;
                  at !== null;
                  at = at.parentElement
                ) {
                  const ancestorStyle = getComputedStyle(at);
                  const ancestorRect = at.getBoundingClientRect();
                  if (ancestorStyle.overflowX !== 'visible') {
                    x0 = Math.max(
                      x0,
                      ancestorRect.x +
                        Number.parseFloat(ancestorStyle.borderLeftWidth),
                    );
                    x1 = Math.min(
                      x1,
                      ancestorRect.right -
                        Number.parseFloat(ancestorStyle.borderRightWidth),
                    );
                  }
                  if (ancestorStyle.overflowY !== 'visible') {
                    y0 = Math.max(
                      y0,
                      ancestorRect.top +
                        Number.parseFloat(ancestorStyle.borderTopWidth),
                    );
                    y1 = Math.min(
                      y1,
                      ancestorRect.bottom -
                        Number.parseFloat(ancestorStyle.borderBottomWidth),
                    );
                  }
                  if (at.classList.contains('pagedjs_page')) break;
                }
                // Infinite only off every page: no clip then (an infinite
                // number doesn't survive the trip out of the browser).
                if ([x0, y0, x1, y1].every(Number.isFinite)) {
                  clipBox = {
                    x: x0,
                    y: y0,
                    width: x1 - x0,
                    height: y1 - y0,
                  };
                }
              }
              // The width each visible border side paints, in top, right,
              // bottom, left order; 0 for a side that paints nothing (an
              // outer <svg> gets no 'box' entry for its borders).
              const sides = (
                outerSvg
                  ? []
                  : [
                      ['border-top-style', 'border-top-width'],
                      ['border-right-style', 'border-right-width'],
                      ['border-bottom-style', 'border-bottom-width'],
                      ['border-left-style', 'border-left-width'],
                    ]
              ).map(([borderStyle = '', borderWidth = ''], i) =>
                visible &&
                !['none', 'hidden'].includes(
                  style.getPropertyValue(borderStyle),
                ) &&
                (alpha[i + 1] ?? 0) > 0
                  ? Number.parseFloat(style.getPropertyValue(borderWidth))
                  : 0,
              );
              const clientRects = Array.from(inner.getClientRects());
              for (const [k, rect] of clientRects.entries()) {
                if (outlines !== undefined) {
                  boxes.push({
                    kind: 'outline',
                    rect: {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height,
                    },
                    width: outlines.width,
                    offset: outlines.offset,
                    ...(clipBox !== undefined ? { clip: clipBox } : {}),
                  });
                }
                for (const shadow of shadows) {
                  // box-decoration-break: slice slices the element's box at
                  // each line end: the left side of every fragment but the
                  // first and the right side of every fragment but the last
                  // (swapped with direction: rtl).
                  const sliced = /** @type {('left' | 'right')[]} */ ([
                    ...(decoration === 'slice' &&
                    clientRects.length > 1 &&
                    k > 0
                      ? [rtl ? 'right' : 'left']
                      : []),
                    ...(decoration === 'slice' &&
                    clientRects.length > 1 &&
                    k < clientRects.length - 1
                      ? [rtl ? 'left' : 'right']
                      : []),
                  ]);
                  boxes.push({
                    kind: 'shadow',
                    rect: {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height,
                    },
                    offsetX: shadow.offsetX,
                    offsetY: shadow.offsetY,
                    blur: shadow.blur,
                    spread: shadow.spread,
                    ...(sliced.length > 0 ? { sliced } : {}),
                    ...(clipBox !== undefined ? { clip: clipBox } : {}),
                  });
                }
                if (background) {
                  boxes.push({
                    kind: pseudo ? 'pseudo' : 'box',
                    rect: {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height,
                    },
                    ...(pseudo && clipBox !== undefined
                      ? { clip: clipBox }
                      : {}),
                  });
                  continue;
                }
                // With border-collapse: collapse a cell's outer half-border
                // lies inside the table's own border box: the outer cells'
                // client rects sit half a border width inside the table's
                // rect (measured: cell [75.063, 101.25, 124.813, 121.563]
                // in a table [74.563, 100.75, 175.063, 142.375] for a 1px
                // border), so a visible border on such a cell paints an ink
                // line right on the table's edge, one the cell's own strips
                // never reach. Count it as a strip on that side of the
                // table's own client rect, of the line's full width.
                const cellWidths =
                  inner instanceof HTMLTableElement &&
                  style.borderCollapse === 'collapse'
                    ? Array.from(inner.querySelectorAll('td, th')).reduce(
                        (widths, cell) => {
                          const cellStyle = getComputedStyle(cell);
                          if (cellStyle.visibility !== 'visible') {
                            return widths;
                          }
                          const cellRect = cell.getBoundingClientRect();
                          const perSide = [
                            cellRect.top - rect.y,
                            rect.x + rect.width - cellRect.right,
                            rect.y + rect.height - cellRect.bottom,
                            cellRect.left - rect.x,
                          ];
                          for (const i of [0, 1, 2, 3]) {
                            const prop = ['top', 'right', 'bottom', 'left'][i];
                            if (
                              ['none', 'hidden'].includes(
                                cellStyle.getPropertyValue(
                                  `border-${prop}-style`,
                                ),
                              )
                            ) {
                              continue;
                            }
                            const color = cellStyle.getPropertyValue(
                              `border-${prop}-color`,
                            );
                            const slash = color.lastIndexOf('/');
                            const parts = color.split(',');
                            const alpha =
                              slash >= 0
                                ? Number.parseFloat(color.slice(slash + 1))
                                : parts.length === 4
                                  ? Number.parseFloat(parts[3] ?? '')
                                  : 1;
                            const width = Number.parseFloat(
                              cellStyle.getPropertyValue(
                                `border-${prop}-width`,
                              ),
                            );
                            if (
                              width > 0 &&
                              alpha > 0 &&
                              (perSide[i] ?? width) <= width / 2 + 0.01
                            ) {
                              widths[i] = Math.max(widths[i] ?? 0, width);
                            }
                          }
                          return widths;
                        },
                        /** @type {number[]} */ ([0, 0, 0, 0]),
                      )
                    : [0, 0, 0, 0];
                const x1 = rect.x + rect.width;
                const y1 = rect.y + rect.height;
                // The visible sides' strips, [x0, y0, x1, y1] each (a NaN
                // width never passes its `> 0` test): the element's own
                // border and, for a collapsed-border table, the line an
                // outer cell's border paints on the table's edge.
                const [wTop = 0, wRight = 0, wBottom = 0, wLeft = 0] =
                  sides.map((width, i) => Math.max(width, cellWidths[i] ?? 0));
                const strips = [
                  ...(wTop > 0 ? [[rect.x, rect.y, x1, rect.y + wTop]] : []),
                  ...(wRight > 0 ? [[x1 - wRight, rect.y, x1, y1]] : []),
                  ...(wBottom > 0 ? [[rect.x, y1 - wBottom, x1, y1]] : []),
                  ...(wLeft > 0 ? [[rect.x, rect.y, rect.x + wLeft, y1]] : []),
                ];
                if (strips.length > 0) {
                  const x0 = Math.min(...strips.map(strip => strip[0] ?? 0));
                  const y0 = Math.min(...strips.map(strip => strip[1] ?? 0));
                  const right0 = Math.max(
                    ...strips.map(strip => strip[2] ?? 0),
                  );
                  const bottom0 = Math.max(
                    ...strips.map(strip => strip[3] ?? 0),
                  );
                  boxes.push({
                    kind: pseudo ? 'pseudo' : 'box',
                    rect: {
                      x: x0,
                      y: y0,
                      width: right0 - x0,
                      height: bottom0 - y0,
                    },
                    ...(pseudo && clipBox !== undefined
                      ? { clip: clipBox }
                      : {}),
                  });
                }
              }
            }
            return boxes;
          },
        ),
      );
    }
  } finally {
    // Whatever happened, the page goes back exactly as it was: spans, the
    // injected style and the host marks (and only those marks) all away.
    for (const span of spans) span.remove();
    if (hiding !== undefined) hiding.remove();
    for (const host of markedHosts) host.removeAttribute(markName);
    markedHosts.clear();
  }
  // KaTeX's MathML copy of a formula that the browser hides (T07-26), as the
  // print runtime's hiddenCopies() decides: a .katex-mathml span or div that
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
        !['span', 'div'].includes(wrapper.localName) ||
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
          // Painted boxes are computed up front, while any rebuilt
          // ::before/::after of the block or of an element in it stands in
          // for its pseudo-element (T08-4); [] when that rebuild had to be
          // undone.
          painted: paintedByElement.get(element) ?? [],
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
  // no computed style changed meanwhile (every property of the block, its
  // ancestors and the elements in it outside the copies, and of their
  // ::before, ::after, ::marker, ::first-letter and ::first-line) and it is
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
    const read = owners.map(([owner]) => {
      /** @type {Element[]} */
      const ancestors = [];
      for (let at = owner.parentElement; at !== null; at = at.parentElement) {
        ancestors.push(at);
      }
      return [
        ...ancestors,
        owner,
        ...Array.from(owner.querySelectorAll('*')).filter(
          element => !copyWrappers.some(wrapper => wrapper.contains(element)),
        ),
      ];
    });
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
                  ...Array.from(style, name => style.getPropertyValue(name)),
                  ...[
                    '::before',
                    '::after',
                    '::marker',
                    '::first-letter',
                    '::first-line',
                  ].flatMap(pseudo => {
                    const generated = getComputedStyle(element, pseudo);
                    return Array.from(generated, name =>
                      generated.getPropertyValue(name),
                    );
                  }),
                ].join(';');
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
