// @ts-check
// The print runtime: loaded by every document the print Worker prints, before
// Paged.js (see src/prepare.ts). It declares only the platform font faces the
// document uses and resolves `window.__pdfgen.ready` once Paged.js has
// finished (docs/findings/T03.md, Must 1 and 8).
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

  // Page margin boxes exist only after pagination, so read the @page rules
  // from the stylesheets' text: each declaration block inside an @page rule.
  function findUsedInPageRules() {
    for (const style of document.querySelectorAll('style')) {
      const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (let at = css.search(/@page\b/i); at !== -1; ) {
        const open = css.indexOf('{', at);
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
          const family = /font-family\s*:\s*([^;}]+)/i.exec(block)?.[1];
          const weight = /font-weight\s*:\s*([^;}]+)/i.exec(block)?.[1];
          if (family) use(family, weight ?? '400');
        }
        const next = css.slice(end).search(/@page\b/i);
        at = next === -1 ? -1 : end + next;
      }
    }
  }

  // Declares only the faces in use (T03 Must 8) and waits for them. A face
  // that fails to load stays in document.fonts with status "error".
  async function loadUsedFaces() {
    findUsedInDocument();
    findUsedInPageRules();
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

  /** @type {(state: { pageCount: number }) => void} */
  let resolveReady = () => {};
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  Object.assign(window, {
    __pdfgen: { ready },
    PagedConfig: {
      auto: true,
      before: loadUsedFaces,
      /** @param {{ total: number }} flow */
      after: flow => {
        resolveReady({ pageCount: flow.total });
      },
    },
  });
})();
