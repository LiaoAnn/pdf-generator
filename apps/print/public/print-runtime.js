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
  // stylesheets' text: a platform family named anywhere in a declaration
  // block's font or font-family, bold when the block asks for bold.
  function findUsedInAtRules() {
    for (const style of document.querySelectorAll('style')) {
      const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
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
    findUsedInDocument();
    findUsedInAtRules();
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
      // data-split-from: put a copy of the source <thead> there first, so its
      // height counts when the rows below are laid out.
      /**
       * @param {Node} clone the node as laid out on the page
       * @param {Node} node the node in the source document
       */
      renderNode(clone, node) {
        if (!(clone instanceof Element)) return;
        const table = clone.closest('table[data-split-from]');
        if (!table || table.querySelector(':scope > thead')) return;
        const source = node instanceof Element ? node.closest('table') : null;
        const thead = source?.querySelector(':scope > thead');
        if (!thead) return;
        const copy = /** @type {Element} */ (thead.cloneNode(true));
        copy.setAttribute('data-repeated-header', '');
        for (const element of [copy, ...copy.querySelectorAll('[data-ref]')]) {
          element.removeAttribute('data-ref');
        }
        const first = [...table.children].find(
          child => child.tagName !== 'CAPTION' && child.tagName !== 'COLGROUP',
        );
        table.insertBefore(copy, first ?? null);
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
  // use its class names.
  function pagedPages() {
    return [...document.querySelectorAll('.pagedjs_pages > .pagedjs_page')];
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

  // Per page, the text of every visible text node inside a [data-gt] element
  // but outside KaTeX's MathML copy, as the PDF's text layer should contain
  // it (T03 Must 4, PDF part).
  function expectedText() {
    return pagedPages().map(page => {
      /** @type {string[]} */
      const texts = [];
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest('[data-gt]')) continue;
        // KaTeX's MathML copy is clipped to 1px for screen readers; only its
        // visible .katex-html is printed, which is also what T13 reads.
        if (node.parentElement.closest('.katex-mathml')) continue;
        const text = (node.textContent ?? '')
          .normalize('NFKC')
          .replace(/\s/g, '');
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const visible = [...range.getClientRects()].some(
          rect => rect.width > 0 && rect.height > 0,
        );
        if (visible) texts.push(text);
      }
      return texts;
    });
  }

  /** @type {(state: { pageCount: number, unloadedFaces: string[], fragmentedRows: string[], expectedText: string[][] }) => void} */
  let resolveReady = () => {};
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  Object.assign(window, {
    __pdfgen: { ready },
    PagedConfig: {
      auto: true,
      before: async () => {
        registerTableHandler();
        await loadUsedFaces();
      },
      /** @param {{ total: number }} flow */
      after: flow => {
        resolveReady({
          pageCount: flow.total,
          unloadedFaces: unloadedFaces(),
          fragmentedRows: fragmentedRows(),
          expectedText: expectedText(),
        });
      },
    },
  });
})();
