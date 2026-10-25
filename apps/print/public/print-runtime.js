// @ts-check
// The print runtime: loaded by every document the print Worker prints, before
// Paged.js (see src/prepare.ts). It declares only the platform font faces the
// document uses and resolves `window.__pdfgen.ready` once Paged.js has
// finished, with the checks of docs/findings/T03.md Must 4 (DOM part) and
// Must 5, and the text the PDF must contain. It also makes tables repeat
// their header and keep rows whole.
(() => {
  /** @type {Record<string, { family: string, regular: string, bold?: string }>} */
  const platformFonts = {
    'noto sans tc': {
      family: 'Noto Sans TC',
      regular: '/fonts/NotoSansTC-Regular.otf',
      bold: '/fonts/NotoSansTC-Bold.otf',
    },
    'noto serif tc': {
      family: 'Noto Serif TC',
      regular: '/fonts/NotoSerifTC-Regular.otf',
      bold: '/fonts/NotoSerifTC-Bold.otf',
    },
    'lxgw wenkai tc': {
      family: 'LXGW WenKai TC',
      regular: '/fonts/LXGWWenKaiTC-Regular.ttf',
    },
    'noto sans symbols 2': {
      family: 'Noto Sans Symbols 2',
      regular: '/fonts/NotoSansSymbols2-Regular.ttf',
    },
  };

  // The pack's stylesheets are linked after this script and may still be
  // loading at DOMContentLoaded. Remember every link that has loaded or
  // failed, from the start, so one that settled early is not waited on.
  /** @type {WeakSet<EventTarget>} */
  const settledLinks = new WeakSet();
  /** @param {Event} event */
  const settle = event => {
    if (event.target instanceof HTMLLinkElement) settledLinks.add(event.target);
  };
  document.addEventListener('load', settle, true);
  document.addEventListener('error', settle, true);
  // The stylesheets Paged.js reads (its Polisher's removeStyles).
  const linkedStylesheets = () => [
    .../** @type {NodeListOf<HTMLLinkElement>} */ (
      document.querySelectorAll("link[rel='stylesheet']")
    ),
  ];
  function stylesheetsSettled() {
    return Promise.all(
      linkedStylesheets().map(link =>
        settledLinks.has(link)
          ? undefined
          : new Promise(resolve => {
              link.addEventListener('load', resolve, { once: true });
              link.addEventListener('error', resolve, { once: true });
            }),
      ),
    );
  }

  /** @type {Set<string>} Faces in use, as "<family key>|regular" or "<family key>|bold". */
  const used = new Set();
  /** @param {string} weight */
  const isBold = weight =>
    /^(bold|bolder)$/i.test(weight.trim()) || Number(weight) >= 600;
  /**
   * @param {string} familyList a CSS font-family value
   * @param {string} weight a CSS font-weight value
   */
  const use = (familyList, weight) => {
    for (const name of familyList.split(',')) {
      const key = name
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase();
      const font = platformFonts[key];
      if (!font) continue;
      used.add(`${key}|${font.bold && isBold(weight) ? 'bold' : 'regular'}`);
    }
  };

  // Elements with their own text, and ::before/::after with content.
  function findUsedInDocument() {
    for (const element of document.querySelectorAll('body, body *')) {
      const ownText = [...element.childNodes].some(
        node =>
          node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '',
      );
      if (ownText) {
        const style = getComputedStyle(element);
        use(style.fontFamily, style.fontWeight);
      }
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (style.content !== 'none' && style.content !== 'normal') {
          use(style.fontFamily, style.fontWeight);
        }
      }
    }
  }

  // Rules computed styles can't show before Paged.js runs: @page rules (margin
  // boxes exist only after pagination) and @media print rules (Paged.js
  // applies them; the page is still on screen media here). Read them from the
  // stylesheets' text, as Paged.js does, of <style> and linked stylesheets
  // alike: a platform family named anywhere in a declaration block's font or
  // font-family, bold when the block asks for bold.
  async function findUsedInAtRules() {
    const texts = [
      ...[...document.querySelectorAll('style')].map(
        style => style.textContent ?? '',
      ),
      ...(await Promise.all(
        linkedStylesheets().map(link =>
          fetch(link.href)
            .then(response => (response.ok ? response.text() : ''))
            .catch(() => ''),
        ),
      )),
    ];
    for (const text of texts) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
      const starts = /@page\b|@media\b[^{;]*\bprint\b/gi;
      for (let match = starts.exec(css); match; match = starts.exec(css)) {
        const open = css.indexOf('{', match.index);
        if (open === -1) break;
        let depth = 0;
        let end = open;
        for (; end < css.length; end++) {
          if (css[end] === '{') depth++;
          else if (css[end] === '}' && --depth === 0) break;
        }
        const rule = css.slice(open + 1, end);
        const outer = rule.replace(/\{[^{}]*\}/g, '');
        for (const block of [outer, ...(rule.match(/\{[^{}]*\}/g) ?? [])]) {
          const weight = /font-weight\s*:\s*([^;}]+)/i.exec(block)?.[1] ?? '';
          const fonts = [
            ...block.matchAll(/font(?:-family)?\s*:\s*([^;}]+)/gi),
          ];
          for (const [, value = ''] of fonts) {
            const lower = value.toLowerCase();
            const bold =
              isBold(weight) || /(^|\s)(bold|bolder|[6-9]00)(\s|$)/.test(lower);
            for (const key of Object.keys(platformFonts)) {
              if (lower.includes(key)) use(key, bold ? '700' : '400');
            }
          }
        }
        starts.lastIndex = end;
      }
    }
  }

  // Declares only the faces in use (T03 Must 8) and waits for them. A face
  // that fails to load stays in document.fonts with status "error".
  async function loadUsedFaces() {
    await stylesheetsSettled();
    findUsedInDocument();
    await findUsedInAtRules();
    const faces = [...used].sort().map(entry => {
      const [key = '', variant] = entry.split('|');
      const font = platformFonts[key];
      if (!font) throw new Error(`unknown platform font ${key}`);
      const bold = variant === 'bold' && font.bold !== undefined;
      const face = new FontFace(
        font.family,
        `url("${bold ? font.bold : font.regular}")`,
        { weight: bold ? '700' : '400', style: 'normal' },
      );
      document.fonts.add(face);
      return face;
    });
    await Promise.all(faces.map(face => face.load().catch(() => undefined)));
  }

  // Paged.js 0.4.3 neither repeats <thead> on a continued page nor keeps a
  // row whole: a row that starts near the page bottom can end up in the
  // page's hidden overflow column and vanish from the PDF (T03 §5).
  function registerTableHandler() {
    /** @type {any} */
    const Paged = /** @type {any} */ (window).Paged;
    class Tables extends Paged.Handler {
      // Called for every node Paged.js lays out. When it rebuilds a table on a
      // new page, the first node it adds sits in a table shell marked
      // data-split-from, a shallow clone without the source's <colgroup>s or
      // <thead>. Put copies of both there first: the <col> widths, or a fixed
      // layout spreads the columns evenly, and the header, so its height
      // counts when the rows below are laid out.
      /**
       * @param {Node} clone the node as laid out on the page
       * @param {Node} node the node in the source document
       */
      renderNode(clone, node) {
        if (!(clone instanceof Element)) return;
        const table = clone.closest('table[data-split-from]');
        if (!table) return;
        const source = node instanceof Element ? node.closest('table') : null;
        if (!source) return;
        /** @param {Element} element */
        const copyOf = element => {
          const copy = /** @type {Element} */ (element.cloneNode(true));
          for (const part of [copy, ...copy.querySelectorAll('[data-ref]')]) {
            part.removeAttribute('data-ref');
          }
          return copy;
        };
        const first = () =>
          [...table.children].find(
            child =>
              child.tagName !== 'CAPTION' && child.tagName !== 'COLGROUP',
          ) ?? null;
        if (!table.querySelector(':scope > colgroup')) {
          const before = first();
          for (const colgroup of source.querySelectorAll(':scope > colgroup')) {
            table.insertBefore(copyOf(colgroup), before);
          }
        }
        const thead = source.querySelector(':scope > thead');
        if (thead && !table.querySelector(':scope > thead')) {
          const copy = copyOf(thead);
          copy.setAttribute('data-repeated-header', '');
          table.insertBefore(copy, first());
        }
      }

      // Called with the range Paged.js is about to move to the next page. If
      // a body row crosses the bottom (or the overflow column) and doesn't
      // start at the top of the page, move the whole row instead. A row
      // taller than a page is left to Paged.js, and the check in `after`
      // fails the render if it ends up fragmented.
      /**
       * @param {Range | undefined} overflow
       * @param {Element} rendered
       * @param {DOMRect} bounds
       */
      onOverflow(overflow, rendered, bounds) {
        for (const row of rendered.querySelectorAll('tr')) {
          if (row.closest('thead')) continue;
          const box = row.getBoundingClientRect();
          const rects = row.getClientRects();
          const crosses =
            rects.length > 1 ||
            Math.floor(box.bottom) > Math.round(bounds.bottom) ||
            Math.floor(box.right) > Math.round(bounds.right) + 1;
          if (!crosses) continue;
          if ((rects[0]?.top ?? box.top) <= bounds.top + 1) return undefined;
          // The overflow already starts at or before this row.
          if (overflow && overflow.comparePoint(row, 0) >= 0) return undefined;
          const range = document.createRange();
          range.setStartBefore(row);
          range.setEndAfter(/** @type {Node} */ (rendered.lastChild));
          return range;
        }
        return undefined;
      }
    }
    Paged.registerHandlers(Tables);
  }

  // The pages Paged.js generated, not elements of the template that happen to
  // use its class names: the `.pagedjs_page` children of the last
  // `.pagedjs_pages` child of <body>. The same rule as ground-truth's
  // collect() (packages/ground-truth/README.md, "Generated pages"), so the
  // slots, the text guard and gt.json agree on which pages exist.
  function pagedPages() {
    const container = [...(document.body?.children ?? [])]
      .filter(child => child.classList.contains('pagedjs_pages'))
      .at(-1);
    return [...(container?.children ?? [])].filter(child =>
      child.classList.contains('pagedjs_page'),
    );
  }

  // Page boxes a template moved (T07-18). gt.json is measured from each
  // generated page's box, so a page that doesn't print at its PDF sheet's
  // origin, or a page box Paged.js didn't place, misplaces every block, and a
  // decoy drawn into a gt box can then pass the self-check's ink comparison.
  // Selectors that never name pagedjs (`body > div > div`) can move them, so
  // this checks the result, not the CSS: each box's own margin, padding,
  // border, position and transforms against what Paged.js 0.4.3 sets (its
  // base stylesheet and @media print block), and where the boxes are: each
  // sheet on its page, the pages stacked without gaps and, in print media,
  // html, body and the pages from the document's origin, each page breaking
  // onto its own sheet, the boxes inside each page where the screen pass
  // found them, and the document no wider than its PDF page. The geometry catches what moves a page without these
  // properties (flex, floats, pseudo-elements, grid placement). Run once on
  // screen, which ground truth measures, and once in print media (lib.ts
  // emulates it), which is what prints: Paged.js leaves screen-only
  // stylesheets live, and the browser's 8px body margin applies on screen
  // only.
  /** @param {{ print?: boolean, pageWidth?: number }} [options] */
  function movedBoxes({ print = false, pageWidth } = {}) {
    /** @type {string[]} */
    const moved = [];
    const tolerance = 0.5;
    const sides = ['top', 'right', 'bottom', 'left'];
    /**
     * @param {Element} element
     * @param {string} name
     * @param {{ position: string, padding?: (side: string) => number | undefined }} expected
     */
    const checkBox = (element, name, expected) => {
      const style = getComputedStyle(element);
      /** @param {string} property @param {string} value */
      const report = (property, value) =>
        moved.push(`${name} ${property}: ${value}`);
      const px = (/** @type {string} */ value) => Number.parseFloat(value);
      for (const side of sides) {
        const margin = style.getPropertyValue(`margin-${side}`);
        if (Math.abs(px(margin)) > tolerance) report(`margin-${side}`, margin);
        const border = style.getPropertyValue(`border-${side}-width`);
        if (name.endsWith('.pagedjs_area')) continue;
        if (px(border) > tolerance) report(`border-${side}-width`, border);
      }
      for (const side of sides) {
        const padding = style.getPropertyValue(`padding-${side}`);
        const want = expected.padding ? expected.padding(side) : 0;
        if (want === undefined || Math.abs(px(padding) - want) > tolerance) {
          report(`padding-${side}`, padding);
        }
      }
      if (style.position !== expected.position) {
        report('position', style.position);
      } else if (style.position === 'relative') {
        for (const side of sides) {
          const inset = style.getPropertyValue(side);
          if (inset !== 'auto' && Math.abs(px(inset)) > tolerance) {
            report(side, inset);
          }
        }
      }
      for (const property of [
        'transform',
        'translate',
        'rotate',
        'scale',
        'offset-path',
      ]) {
        const value = style.getPropertyValue(property);
        if (value !== 'none') report(property, value);
      }
      const zoom = style.getPropertyValue('zoom');
      if (zoom !== '1' && zoom !== 'normal') report('zoom', zoom);
    };
    /** @param {Element} element */
    const at = element => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + scrollX,
        y: rect.top + scrollY,
        height: rect.height,
      };
    };
    /** @param {string} name @param {{ x: number, y: number }} box @param {{ x: number, y: number }} want */
    const place = (name, box, want) => {
      if (
        Math.abs(box.x - want.x) > tolerance ||
        Math.abs(box.y - want.y) > tolerance
      ) {
        moved.push(
          `${name} at (${box.x.toFixed(1)}, ${box.y.toFixed(1)}) px, expected (${want.x.toFixed(1)}, ${want.y.toFixed(1)})`,
        );
      }
    };
    const pages = pagedPages();
    // Wider than the PDF page, the document is shrunk to fit it when printed,
    // boxes and all (lib.ts sets the viewport to the page's width, rounded
    // down; scrollWidth is rounded).
    const width = document.documentElement.scrollWidth;
    if (pageWidth !== undefined && width > Math.ceil(pageWidth)) {
      moved.push(
        `document ${width}px wide, wider than its ${pageWidth.toFixed(1)}px PDF page`,
      );
    }
    if (print) {
      const container = pages[0]?.parentElement;
      for (const [
        element,
        name,
      ] of /** @type {[Element | null | undefined, string][]} */ ([
        [document.documentElement, 'html'],
        [document.body, 'body'],
        [container, '.pagedjs_pages'],
      ])) {
        if (!element) continue;
        checkBox(element, name, { position: 'static' });
        place(name, at(element), { x: 0, y: 0 });
      }
    }
    const first = pages[0] ? at(pages[0]) : { x: 0, y: 0 };
    let top = print ? 0 : first.y;
    const left = print ? 0 : first.x;
    pages.forEach((page, i) => {
      const name = `page ${i + 1}`;
      const box = at(page);
      checkBox(page, `${name} .pagedjs_page`, { position: 'static' });
      place(`${name} .pagedjs_page`, box, { x: left, y: top });
      top += box.height;
      if (print && getComputedStyle(page).breakAfter !== 'page') {
        moved.push(
          `${name} .pagedjs_page break-after: ${getComputedStyle(page).breakAfter}`,
        );
      }
      const sheet = page.querySelector(':scope > .pagedjs_sheet');
      const pagebox = sheet?.querySelector(':scope > .pagedjs_pagebox');
      const area = pagebox?.querySelector(':scope > .pagedjs_area');
      const content = area?.querySelector(':scope > .pagedjs_page_content');
      if (!sheet || !pagebox || !area || !content) {
        moved.push(`${name}: Paged.js page boxes missing`);
        return;
      }
      checkBox(sheet, `${name} .pagedjs_sheet`, { position: 'relative' });
      place(`${name} .pagedjs_sheet`, at(sheet), box);
      checkBox(pagebox, `${name} .pagedjs_pagebox`, { position: 'relative' });
      const areaStyle = getComputedStyle(area);
      checkBox(area, `${name} .pagedjs_area`, {
        position: 'static',
        padding: side =>
          lengthPx(areaStyle.getPropertyValue(`--pagedjs-padding-${side}`)),
      });
      checkBox(content, `${name} .pagedjs_page_content`, {
        position: 'relative',
      });
      // The boxes inside the page, relative to it: in print media where the
      // screen measurement (ground truth) put them. A template can move them
      // on screen only (a screen stylesheet's grid tracks, area border or
      // grid placement) without changing what the checks above compare.
      // The sheet's height follows the viewport in print media, so only its
      // corner counts.
      const inner = [
        { box: sheet, name: '.pagedjs_sheet', sized: false },
        { box: pagebox, name: '.pagedjs_pagebox', sized: true },
        { box: area, name: '.pagedjs_area', sized: true },
        { box: content, name: '.pagedjs_page_content', sized: true },
      ].map(({ box: element, name: boxName, sized }) => {
        const rect = element.getBoundingClientRect();
        const origin = page.getBoundingClientRect();
        return {
          name: `${name} ${boxName}`,
          x: rect.left - origin.left,
          y: rect.top - origin.top,
          width: sized ? rect.width : 0,
          height: sized ? rect.height : 0,
        };
      });
      if (!print) {
        screenBoxes[i] = inner;
        return;
      }
      inner.forEach((printed, j) => {
        const screen = screenBoxes[i]?.[j];
        const same =
          screen !== undefined &&
          ['x', 'y', 'width', 'height'].every(
            key =>
              Math.abs(
                printed[/** @type {'x'} */ (key)] -
                  screen[/** @type {'x'} */ (key)],
              ) <= tolerance,
          );
        if (!same) {
          const show = (/** @type {typeof printed | undefined} */ b) =>
            b
              ? `(${b.x.toFixed(1)}, ${b.y.toFixed(1)}) ${b.width.toFixed(1)}x${b.height.toFixed(1)}`
              : 'missing';
          moved.push(
            `${printed.name} in print ${show(printed)} px, on screen ${show(screen)}`,
          );
        }
      });
    });
    return moved;
  }
  /**
   * Each page's inner boxes relative to it, as the screen pass measured them.
   * @type {{ name: string, x: number, y: number, width: number, height: number }[][]}
   */
  const screenBoxes = [];

  // An absolute CSS length (Paged.js's padding variables) in px, or undefined.
  /** @param {string} value */
  function lengthPx(value) {
    const text = value.trim();
    if (text === '' || text === '0') return 0;
    try {
      return CSSNumericValue.parse(text).to('px').value;
    } catch {
      return undefined;
    }
  }

  // Per page, whether it paints anything at the page's own scale: text, or a
  // background or border, of an element (or its ::before/::after) outside
  // SVG drawings and outside CSS transforms and filters. Chrome draws those at
  // 0.75 pt per CSS px, so lib.ts can tell from the PDF whether such a page
  // was printed at another scale (T07-18); a page that paints only SVG or
  // transformed content can't be told apart from a scaled one.
  function plainInk() {
    /** @param {CSSStyleDeclaration} style */
    const paints = style =>
      !/^(?:transparent|rgba\(.*,\s*0\))$/.test(style.backgroundColor) ||
      ['top', 'right', 'bottom', 'left'].some(
        side =>
          Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) >
            0 &&
          !/^(?:none|hidden)$/.test(
            style.getPropertyValue(`border-${side}-style`),
          ),
      );
    /** @param {CSSStyleDeclaration} style */
    const plain = style =>
      ['transform', 'translate', 'rotate', 'scale', 'filter'].every(
        property => style.getPropertyValue(property) === 'none',
      );
    return pagedPages().map(page => {
      const outside = new Set();
      for (const element of page.querySelectorAll('*')) {
        if (element instanceof SVGElement) continue;
        const style = getComputedStyle(element);
        const parent = element.parentElement;
        if (
          !plain(style) ||
          (parent && parent !== page && outside.has(parent))
        ) {
          outside.add(element);
          continue;
        }
        if (style.visibility !== 'visible') continue;
        const text = [...element.childNodes].some(
          node =>
            node.nodeType === Node.TEXT_NODE &&
            (node.textContent ?? '').trim() !== '',
        );
        if ((text || paints(style)) && element.getClientRects().length > 0) {
          return true;
        }
        for (const pseudo of ['::before', '::after']) {
          const box = getComputedStyle(element, pseudo);
          if (
            box.content !== 'none' &&
            box.content !== 'normal' &&
            paints(box)
          ) {
            return true;
          }
        }
      }
      return false;
    });
  }

  // Faces that did not load: Paged.js only warns about them (T03 Must 5).
  function unloadedFaces() {
    /** @type {string[]} */
    const faces = [];
    document.fonts.forEach(face => {
      if (face.status !== 'loaded') {
        const family = face.family.replace(/^["']|["']$/g, '');
        faces.push(`${family} ${face.weight}: ${face.status}`);
      }
    });
    return faces;
  }

  // Rows with text that are split or reach outside their page's content
  // area: their text may be missing from the PDF (T03 Must 4).
  function fragmentedRows() {
    /** @type {string[]} */
    const rows = [];
    pagedPages().forEach((page, i) => {
      const content = page.querySelector('.pagedjs_page_content');
      if (!content) return;
      const area = content.getBoundingClientRect();
      for (const row of page.querySelectorAll('tr')) {
        const text = (row.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const box = row.getBoundingClientRect();
        if (
          row.getClientRects().length > 1 ||
          box.right > area.right + 1 ||
          box.bottom > area.bottom + 1
        ) {
          rows.push(`page ${i + 1}: ${text.slice(0, 40)}`);
        }
      }
    });
    return rows;
  }

  // Per page, each [data-gt] element's visible text nodes outside KaTeX's
  // MathML copy, each with its client rects (PDF points from the page's top
  // left), as the PDF's text layer should contain them there (T03 Must 4, PDF
  // part). A text is matched only within its own rects, so a formula's single
  // letters (T07-6) or a neighbouring table cell (T07-12) can't lend it
  // letters. The rects are where the text is, also where it overflows its
  // element or is positioned outside it: whether text lies in its block's box
  // is the self-check's to report (T14), not this guard's.
  function expectedText() {
    const ptPerPx = 0.75;
    return pagedPages().map(page => {
      const origin = page.getBoundingClientRect();
      /** @type {Map<Element, { text: string, boxes: { x0: number, y0: number, x1: number, y1: number }[] }[]>} */
      const blocks = new Map();
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement?.closest('[data-gt]');
        if (!element) continue;
        // KaTeX's MathML copy is clipped to 1px for screen readers; only its
        // visible .katex-html is printed, which is also what T13 reads.
        if (node.parentElement?.closest('.katex-mathml')) continue;
        const text = (node.textContent ?? '')
          .normalize('NFKC')
          .replace(/\s/g, '');
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(
          rect => rect.width > 0 && rect.height > 0,
        );
        if (rects.length === 0) continue;
        const texts = blocks.get(element) ?? [];
        texts.push({
          text,
          boxes: rects.map(rect => ({
            x0: (rect.left - origin.left) * ptPerPx,
            y0: (rect.top - origin.top) * ptPerPx,
            x1: (rect.right - origin.left) * ptPerPx,
            y1: (rect.bottom - origin.top) * ptPerPx,
          })),
        });
        blocks.set(element, texts);
      }
      return [...blocks.values()].map(texts => ({ texts }));
    });
  }

  // Writes each page's number and the page count into the page-number slots
  // (T02-5), clones of a running element included, before anything reads the
  // text: the ground truth, the text guard and the PDF all see the digits.
  /** @param {number} total */
  function fillPageNumbers(total) {
    pagedPages().forEach((page, i) => {
      for (const slot of page.querySelectorAll('[data-gt-page-number]')) {
        slot.textContent = String(i + 1);
      }
      for (const slot of page.querySelectorAll('[data-gt-page-count]')) {
        slot.textContent = String(total);
      }
    });
  }

  /** @type {(state: { pageCount: number, unloadedFaces: string[], fragmentedRows: string[], movedBoxes: string[], plainInk: boolean[], expectedText: { texts: { text: string, boxes: { x0: number, y0: number, x1: number, y1: number }[] }[] }[][] }) => void} */
  let resolveReady = () => {};
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  Object.assign(window, {
    // lib.ts calls movedBoxes again in print media.
    __pdfgen: { ready, movedBoxes },
    PagedConfig: {
      auto: true,
      before: async () => {
        registerTableHandler();
        await loadUsedFaces();
      },
      /** @param {{ total: number }} flow */
      after: flow => {
        fillPageNumbers(flow.total);
        resolveReady({
          pageCount: flow.total,
          unloadedFaces: unloadedFaces(),
          fragmentedRows: fragmentedRows(),
          movedBoxes: movedBoxes(),
          plainInk: plainInk(),
          expectedText: expectedText(),
        });
      },
    },
  });
})();
