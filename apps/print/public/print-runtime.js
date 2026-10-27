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

  // Elements with their own text, and ::before/::after with content. A
  // page-number slot (T02-5) counts as having text: fillPageNumbers writes its
  // digits only after Paged.js has laid the pages out.
  function findUsedInDocument() {
    for (const element of document.querySelectorAll('body, body *')) {
      const ownText =
        element.matches('[data-gt-page-number], [data-gt-page-count]') ||
        [...element.childNodes].some(
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

  // A print-only block's declarations, and those of the blocks nested in it
  // (an @page's margin boxes, a @media print's rules): a platform family named
  // in font or font-family, bold when that block asks for bold.
  /** @param {string} body a block's contents, without its braces */
  function usePrintBlock(body) {
    let own = '';
    let depth = 0;
    let start = 0;
    for (let index = 0; index < body.length; index++) {
      if (body[index] === '{') {
        if (depth++ === 0) {
          own += body.slice(start, index);
          start = index + 1;
        }
      } else if (body[index] === '}' && depth > 0 && --depth === 0) {
        usePrintBlock(body.slice(start, index));
        start = index + 1;
      }
    }
    if (depth === 0) own += body.slice(start);
    else usePrintBlock(body.slice(start));
    const weight = /font-weight\s*:\s*([^;}]+)/i.exec(own)?.[1] ?? '';
    for (const [, value = ''] of own.matchAll(
      /font(?:-family)?\s*:\s*([^;}]+)/gi,
    )) {
      const lower = value.toLowerCase();
      const bold =
        isBold(weight) || /(^|\s)(bold|bolder|[6-9]00)(\s|$)/.test(lower);
      for (const key of Object.keys(platformFonts)) {
        if (lower.includes(key)) use(key, bold ? '700' : '400');
      }
    }
  }

  // Whether an @import with this media list applies to the print: all but
  // screen- or speech-only lists (Paged.js applies the rest).
  /** @param {string} media */
  const printsWith = media =>
    !media
      .split(',')
      .every(query => /^\s*(only\s+)?(screen|speech)\b/i.test(query));

  // Rules computed styles can't show before Paged.js runs: @page rules (margin
  // boxes exist only after pagination) and @media print rules (Paged.js
  // applies them; the page is still on screen media here). Read them from the
  // stylesheets' text, as Paged.js does, of <style> and linked stylesheets
  // alike, and of the sheets they @import: a platform family named anywhere in
  // a declaration block's font or font-family, bold when the block asks for
  // bold.
  async function findUsedInAtRules() {
    /** @type {Set<string>} Imports already read, as "<print>|<url>". */
    const imported = new Set();
    /** @param {string} url */
    const fetchText = url =>
      fetch(url)
        .then(response => (response.ok ? response.text() : ''))
        .catch(() => '');
    /**
     * Reads one sheet's imports, then its print-only rules. An import with a
     * media list (`@import "p.css" print;`) applies to the print as a whole
     * sheet that screen styles never showed, so all of its rules count;
     * screen- or speech-only imports don't print at all.
     * @param {string} text
     * @param {string} base the URL the sheet's relative URLs resolve against
     * @param {boolean} print whether the whole sheet applies only in print
     * @returns {Promise<void>}
     */
    const scan = async (text, base, print) => {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
      const imports =
        /@import\s+(?:url\(\s*(["']?)(.*?)\1\s*\)|(["'])(.*?)\3)([^;]*);/gi;
      for (const [, , urlHref, , stringHref, media = ''] of css.matchAll(
        imports,
      )) {
        if (!printsWith(media)) continue;
        let url;
        try {
          url = new URL(urlHref ?? stringHref ?? '', base).href;
        } catch {
          continue;
        }
        const importPrint = print || media.trim() !== '';
        const key = `${importPrint}|${url}`;
        if (imported.has(key)) continue;
        imported.add(key);
        await scan(await fetchText(url), url, importPrint);
      }
      if (print) {
        usePrintBlock(css);
        return;
      }
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
        usePrintBlock(css.slice(open + 1, end));
        starts.lastIndex = end;
      }
    };
    await Promise.all([
      ...[...document.querySelectorAll('style')].map(style =>
        scan(style.textContent ?? '', document.baseURI, false),
      ),
      ...linkedStylesheets().map(async link =>
        scan(await fetchText(link.href), link.href, false),
      ),
    ]);
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
  // screen, where Paged.js paginates, and once in print media (`printed`),
  // which is what prints and where ground truth is read: Paged.js leaves
  // screen-only stylesheets live, and the browser's 8px body margin applies
  // on screen only.
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
    const visible = (/** @type {string} */ color) =>
      !/^(?:transparent|rgba\(.*,\s*0\))$/.test(color);
    /** @param {CSSStyleDeclaration} style */
    const paints = style =>
      visible(style.backgroundColor) ||
      ['top', 'right', 'bottom', 'left'].some(
        side =>
          Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) >
            0 &&
          !/^(?:none|hidden)$/.test(
            style.getPropertyValue(`border-${side}-style`),
          ) &&
          visible(style.getPropertyValue(`border-${side}-color`)),
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
            plain(box) &&
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

  // The data-gt elements (and what is inside them) in each page's content
  // area that reach outside it, by `"<page> <n>"` (the n-th of the page's
  // data-gt elements and descendants) with how far:
  // the PDF clips them or Paged.js's overflow column hides them. Paged.js
  // breaks the pages on screen; `printed` reports those outside only in
  // print, which a style that applies only there (a data-pagedjs-ignore
  // sheet's @media print, a <style> in <body>) can make taller or wider than
  // the page Paged.js gave them (T07-23).
  function outsidePages() {
    const tolerance = 0.5;
    const round = (/** @type {number} */ value) => value.toFixed(1);
    /** @type {Map<string, string>} */
    const outside = new Map();
    pagedPages().forEach((page, index) => {
      const content = page.querySelector(
        ':scope > .pagedjs_sheet > .pagedjs_pagebox > .pagedjs_area > .pagedjs_page_content',
      );
      if (!content) return;
      const area = content.getBoundingClientRect();
      [...content.querySelectorAll('[data-gt], [data-gt] *')].forEach(
        (element, n) => {
          if (element.getClientRects().length === 0) return;
          const box = element.getBoundingClientRect();
          const below = box.bottom - area.bottom;
          const right = box.right - area.right;
          if (below > tolerance || right > tolerance) {
            outside.set(
              `${index + 1} ${n}`,
              `page ${index + 1} ${element.localName}${below > tolerance ? ` ${round(below)}px below` : ''}${right > tolerance ? ` ${round(right)}px right of` : ''} its content area`,
            );
          }
        },
      );
    });
    return outside;
  }
  /** Keys of `outsidePages()` on screen, once Paged.js has finished. */
  let outsideOnScreen = new Set();

  // The data-gt elements (and what is inside them) that an ancestor clips:
  // gt.json describes their whole box and text, the PDF shows only what the
  // clip leaves (T07-25). The browser says what it shows: an
  // IntersectionObserver rooted at <html> clips each box by every ancestor
  // that clips it (overflow, contain: paint, clip-path, ...), and not by one
  // an absolutely positioned box escapes. Only the part inside the page's
  // content area counts; reaching outside it is outsidePages()'s to report.
  // Skipped, unless marked data-gt themselves: an SVG's drawing, which its
  // <svg> clips by design (text in it counts), and MathML in a .katex-mathml
  // element that shows at most 1px of it, as KaTeX's CSS hides its MathML
  // copy. What the browser shows decides, not the class or the CSS: a pack
  // can name any element katex-mathml and style it to look hidden.
  async function clippedContent() {
    const tolerance = 1;
    const round = (/** @type {number} */ value) => value.toFixed(1);
    /** @type {{ element: Element, page: number, area: DOMRect, copy: boolean }[]} */
    const targets = [];
    pagedPages().forEach((page, index) => {
      const content = page.querySelector(
        ':scope > .pagedjs_sheet > .pagedjs_pagebox > .pagedjs_area > .pagedjs_page_content',
      );
      if (!content) return;
      const area = content.getBoundingClientRect();
      for (const element of content.querySelectorAll(
        '[data-gt], [data-gt] *',
      )) {
        const marked = element.hasAttribute('data-gt');
        if (
          !marked &&
          element instanceof SVGElement &&
          !(element instanceof SVGTextContentElement)
        ) {
          continue;
        }
        if (element.getClientRects().length === 0) continue;
        const copy =
          !marked &&
          element.namespaceURI === 'http://www.w3.org/1998/Math/MathML' &&
          element.closest('.katex-mathml') !== null;
        targets.push({ element, page: index + 1, area, copy });
      }
    });
    if (targets.length === 0) return [];
    /** @type {Map<Element, IntersectionObserverEntry>} */
    const seen = new Map();
    // Every target is reported at the next rendering update; one that isn't
    // within the time limit is reported as not measured.
    await new Promise(resolve => {
      const observer = new IntersectionObserver(
        entries => {
          for (const entry of entries) seen.set(entry.target, entry);
          if (seen.size >= targets.length) {
            observer.disconnect();
            resolve(undefined);
          }
        },
        // Without the margin, boxes on later pages read as clipped
        // entirely (<html>'s box doesn't reach them in print media).
        { root: document.documentElement, rootMargin: '1000000px' },
      );
      for (const { element } of targets) observer.observe(element);
      setTimeout(() => {
        observer.disconnect();
        resolve(undefined);
      }, 2000);
    });
    /** @type {string[]} */
    const clipped = [];
    for (const { element, page, area, copy } of targets) {
      const entry = seen.get(element);
      if (!entry) {
        clipped.push(`page ${page} ${element.localName} not measured`);
        continue;
      }
      const shown = entry.intersectionRect;
      if (
        copy &&
        (!entry.isIntersecting || (shown.width <= 1 && shown.height <= 1))
      ) {
        continue;
      }
      const box = entry.boundingClientRect;
      const top = Math.max(box.top, area.top);
      const right = Math.min(box.right, area.right);
      const bottom = Math.min(box.bottom, area.bottom);
      const left = Math.max(box.left, area.left);
      if (right - left <= 0 || bottom - top <= 0) continue;
      /** @type {[string, number][]} */
      const sides = [
        ['top', shown.top - top],
        ['right', right - shown.right],
        ['bottom', bottom - shown.bottom],
        ['left', shown.left - left],
      ];
      const cut = sides.filter(([, by]) => by > tolerance);
      if (!entry.isIntersecting) {
        clipped.push(`page ${page} ${element.localName} clipped entirely`);
      } else if (cut.length > 0) {
        clipped.push(
          `page ${page} ${element.localName} clipped ${cut
            .map(([side, by]) => `${round(by)}px at the ${side}`)
            .join(', ')}`,
        );
      }
    }
    return clipped.slice(0, 50);
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

  // CSS escapes, as Chrome reads them: `100v\77` is 100vw.
  /** @param {string} text */
  const unescapeCss = text =>
    text.replace(
      /\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^\n])/gi,
      (
        _,
        /** @type {string | undefined} */ hex,
        /** @type {string} */ char,
      ) => {
        if (!hex) return char;
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '\ufffd';
      },
    );
  /** Whether `display: none` on the element or an ancestor hides it. */
  /** @param {Element} element */
  function hiddenByDisplay(element) {
    for (
      let at = /** @type {Element | null} */ (element);
      at;
      at = at.parentElement
    ) {
      if (getComputedStyle(at).display === 'none') return true;
    }
    return false;
  }

  // What still depends on the viewport where the data-gt boxes don't show
  // it. lib.ts reads the boxes at floor and ceil of the page size (Chrome
  // prints between the two) and at the viewport Paged.js paginated at, which
  // covers CSS that lays out by the viewport's size (T07-22). Not covered:
  // position: fixed (placed relative to the viewport and printed on every
  // page) and a <picture> source chosen by media (switching media switches
  // the image, which isn't loaded when the PDF is printed).
  function viewportDependent() {
    /** @type {Set<string>} */
    const found = new Set();
    /** @param {string} where @param {string} text */
    const report = (where, text) =>
      found.add(`${where}: ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    for (const element of document.querySelectorAll('*')) {
      const tag = `<${element.localName}>`;
      // A box only, so not what display: none or a ::before without content
      // hides. (A display: contents host has no box, its ::before/::after
      // can.)
      if (!hiddenByDisplay(element)) {
        for (const pseudo of ['', '::before', '::after']) {
          const style = getComputedStyle(element, pseudo || null);
          const box = pseudo
            ? style.display !== 'none' &&
              style.content !== 'none' &&
              style.content !== 'normal'
            : element.getClientRects().length > 0;
          if (box && style.position === 'fixed') {
            report(`${tag}${pseudo}`, 'position: fixed');
          }
        }
      }
      const media = element.getAttribute('media');
      if (
        media !== null &&
        (element.localName === 'img' || element.localName === 'source') &&
        element.parentElement?.localName === 'picture'
      ) {
        report(`${tag} media`, media);
      }
    }
    return [...found].slice(0, 50);
  }

  // What moves over time: CSS animations, running transitions (entering
  // print media starts the transitions of what its rules change), SVG
  // animation elements and <marquee>. The PDF and the ground truth would
  // each catch them at a different moment (T07-20).
  function animations() {
    /** @type {Set<string>} */
    const found = new Set();
    // The @keyframes names that exist: a name without them animates nothing.
    /** @type {Set<string>} */
    const keyframes = new Set();
    /** @param {CSSRuleList} rules */
    const collect = rules => {
      for (const rule of rules) {
        if (rule instanceof CSSKeyframesRule) keyframes.add(rule.name);
        if (rule instanceof CSSImportRule && rule.styleSheet) {
          try {
            collect(rule.styleSheet.cssRules);
          } catch {}
        }
        if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
          collect(rule.cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        collect(sheet.cssRules);
      } catch {}
    }
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      const target =
        effect instanceof KeyframeEffect && effect.target
          ? `<${effect.target.localName}>${effect.pseudoElement ?? ''}`
          : 'document';
      const what =
        animation instanceof CSSAnimation
          ? `animation ${animation.animationName}`
          : animation instanceof CSSTransition
            ? `transition ${animation.transitionProperty}`
            : 'animation';
      found.add(`${target}: ${what}`);
    }
    const animating = new Set([
      'animate',
      'animatetransform',
      'animatemotion',
      'set',
    ]);
    for (const element of document.querySelectorAll('*')) {
      // Applied animations, whether or not they run now: one that has ended
      // still runs from its start when Chrome prints.
      for (const pseudo of ['', '::before', '::after']) {
        const { animationName } = getComputedStyle(element, pseudo || null);
        if (
          animationName
            .split(/(?<!\\),/)
            .some(name =>
              keyframes.has(
                unescapeCss(name.trim().replace(/^(["'])(.*)\1$/, '$2')),
              ),
            )
        ) {
          found.add(
            `<${element.localName}>${pseudo}: animation ${animationName}`,
          );
        }
      }
      const name = element.localName.toLowerCase();
      if (
        (element instanceof SVGElement && animating.has(name)) ||
        name === 'marquee'
      ) {
        found.add(`<${element.localName}>`);
      }
    }
    return [...found].slice(0, 50);
  }

  // Per laid-out [data-gt] element, `"<page> <left>,<top>,<right>,<bottom>"`
  // in CSS px from its page's top left: lib.ts compares them just before and
  // after printing, to catch a layout still changing (T07-20).
  function gtBoxes() {
    const pages = pagedPages();
    const round = (/** @type {number} */ value) =>
      Math.round(value * 100) / 100;
    return [...document.querySelectorAll('[data-gt]')]
      .filter(element => element.getClientRects().length > 0)
      .map(element => {
        const index = pages.findIndex(page => page.contains(element));
        const origin = pages[index]?.getBoundingClientRect() ?? {
          left: 0,
          top: 0,
        };
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return `${index + 1} ${[left - origin.left, top - origin.top, right - origin.left, bottom - origin.top].map(round).join(',')}`;
      });
  }

  // The pack's elements in the Paged.js pages (the laid-out content, and
  // data-gt elements wherever they are, with their descendants), in document
  // order, as `"<tag> <page> <left>,<top>,<right>,<bottom>"` from the page's
  // top left (`none` without a box): lib.ts compares the lists entry by
  // entry at the viewports that bracket the printed one (T07-22). Not just
  // data-gt elements, whose boxes stay put while table cells, checkboxes or
  // an unmarked descendant inside them move; by entry, so blocks that trade
  // places don't compare equal. Not Paged.js's own page boxes, which its
  // print styles make as tall as the viewport.
  function layoutBoxes() {
    const pages = pagedPages();
    const round = (/** @type {number} */ value) =>
      Math.round(value * 100) / 100;
    return pages.flatMap((page, index) => {
      const origin = page.getBoundingClientRect();
      const content = page.querySelectorAll(
        '.pagedjs_page_content *, [data-gt], [data-gt] *',
      );
      return [...content].map(element => {
        const box = element.getBoundingClientRect();
        const where =
          element.getClientRects().length > 0
            ? [
                box.left - origin.left,
                box.top - origin.top,
                box.right - origin.left,
                box.bottom - origin.top,
              ]
                .map(round)
                .join(',')
            : 'none';
        return `${element.localName} ${index + 1} ${where}`;
      });
    });
  }

  // The largest Paged.js page, in CSS px: the viewport lib.ts emulates print
  // media at before printing.
  function pageSize() {
    let width = 0;
    let height = 0;
    for (const page of pagedPages()) {
      const rect = page.getBoundingClientRect();
      width = Math.max(width, rect.width);
      height = Math.max(height, rect.height);
    }
    return { width, height };
  }

  // Waits for what print media made the page load: fonts and images (lib.ts
  // also waits for the requests themselves, and calls this until no new
  // request starts).
  async function loadPrintResources() {
    // Style and layout start the requests print media needs (background and
    // generated images, fonts); a frame lets them go out.
    document.body?.getBoundingClientRect();
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 100);
    });
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map(image => image.decode().catch(() => undefined)),
    );
  }

  // What the PDF shows, measured in print media (lib.ts emulates it at the
  // page size), once before and once after printing: the data-gt boxes,
  // fonts, animations, the checks of the page boxes, the table rows and the
  // data-gt text, and the scale guard's ink. Paged.js leaves stylesheets that
  // apply in one medium only live (`media="screen"`, data-pagedjs-ignore,
  // `@media all and (…)`), so these and the ground truth, which lib.ts reads
  // right after, must not be read on screen (T07-20).
  /** @param {{ pageWidth: number }} options */
  async function printed({ pageWidth }) {
    return {
      animations: animations(),
      viewportDependent: viewportDependent(),
      unloadedFaces: unloadedFaces(),
      boxes: gtBoxes(),
      movedBoxes: movedBoxes({ print: true, pageWidth }),
      fragmentedRows: fragmentedRows(),
      outsidePages: [...outsidePages()]
        .filter(([key]) => !outsideOnScreen.has(key))
        .map(([, where]) => where)
        .slice(0, 50),
      clippedContent: await clippedContent(),
      plainInk: plainInk(),
      expectedText: expectedText(),
    };
  }

  /** @type {(state: { pageCount: number, pageSize: { width: number, height: number }, unloadedFaces: string[], movedBoxes: string[], viewportDependent: string[], animations: string[], boxes: string[] }) => void} */
  let resolveReady = () => {};
  /** @type {string[]} */
  let sourceViewportDependent = [];
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  Object.assign(window, {
    // lib.ts calls these in print media, before and after printing the PDF,
    // and reads the boxes at the viewports it compares.
    __pdfgen: {
      ready,
      loadPrintResources,
      printed,
      /** @param {number} [pageWidth] in print media: check the page boxes */
      boxes: pageWidth => ({
        boxes: layoutBoxes(),
        viewportDependent: viewportDependent(),
        animations: animations(),
        ...(pageWidth === undefined
          ? {}
          : { movedBoxes: movedBoxes({ print: true, pageWidth }) }),
      }),
    },
    PagedConfig: {
      auto: true,
      before: async () => {
        registerTableHandler();
        await loadUsedFaces();
        // Before Paged.js replaces the pack's stylesheets with its rewrite,
        // which handles position: fixed itself.
        sourceViewportDependent = viewportDependent();
      },
      /** @param {{ total: number }} flow */
      after: flow => {
        fillPageNumbers(flow.total);
        outsideOnScreen = new Set(outsidePages().keys());
        resolveReady({
          pageCount: flow.total,
          pageSize: pageSize(),
          unloadedFaces: unloadedFaces(),
          movedBoxes: movedBoxes(),
          animations: animations(),
          viewportDependent: [
            ...new Set([...sourceViewportDependent, ...viewportDependent()]),
          ].slice(0, 50),
          // On screen, at the viewport Paged.js paginated at.
          boxes: layoutBoxes(),
        });
      },
    },
  });
})();
