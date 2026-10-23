// Measurement probe, loaded before Paged.js. Records data-gt boxes at several moments
// so the spike can show which moment matches the printed PDF.
(() => {
  const PX_TO_PT = 0.75;
  const t0 = performance.now();
  const snapshots = {};
  const log = [];
  const mark = (name) => log.push({ name, ms: Math.round(performance.now() - t0) });

  function readBoxes() {
    const pages = [...document.querySelectorAll('.pagedjs_page')];
    const out = [];
    const els = document.querySelectorAll('[data-gt]');
    for (const el of els) {
      const page = el.closest('.pagedjs_page');
      const origin = page ? page.getBoundingClientRect() : { left: 0, top: 0 };
      const pageNo = page ? pages.indexOf(page) + 1 : 0;
      const r = el.getBoundingClientRect();
      const rel = (x, y) => [(x - origin.left) * PX_TO_PT, (y - origin.top) * PX_TO_PT];
      const [x0, y0] = rel(r.left, r.top);
      const [x1, y1] = rel(r.right, r.bottom);
      // Tight text lines: one rect per line fragment of every text node.
      const lines = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const lr of range.getClientRects()) {
          const [a, b] = rel(lr.left, lr.top);
          const [c, d] = rel(lr.right, lr.bottom);
          lines.push([a, b, c, d].map((v) => Math.round(v * 100) / 100));
        }
      }
      out.push({
        id: el.dataset.gtId,
        type: el.dataset.gt,
        page: pageNo,
        splitFrom: el.dataset.splitFrom || null,
        box: [x0, y0, x1, y1].map((v) => Math.round(v * 100) / 100),
        text: el.innerText.replace(/\s+/g, ''),
        lines,
      });
    }
    return { pageCount: pages.length, blocks: out };
  }

  const snap = (name) => {
    mark(name);
    snapshots[name] = readBoxes();
  };

  document.addEventListener('DOMContentLoaded', () => snap('domContentLoaded'));
  window.addEventListener('load', () => snap('load'));
  document.fonts.ready.then(() => snap('fontsReady'));

  window.PagedConfig = {
    auto: true,
    before: async () => {
      // Fonts must be loaded before Paged.js measures, or the layout is done in a fallback font.
      await document.fonts.ready;
      snap('beforePaged');
    },
    after: async (flow) => {
      snap('pagedAfter');
      // Record any declared font face that failed to load; Paged.js only warns about it.
      const faces = [];
      document.fonts.forEach((f) => faces.push({ family: f.family, weight: f.weight, status: f.status }));
      window.__t03 = { done: true, total: flow.total, performanceMs: Math.round(flow.performance), faces, log };
    },
  };
  window.__t03 = { done: false, log };
  window.__t03snap = snap;
  window.__t03snapshots = snapshots;
  window.__t03readBoxes = readBoxes;
  // Guard: text that Paged.js left outside its page's content area (clipped, so missing from the PDF).
  window.__t03overflow = () => {
    const hits = [];
    for (const content of document.querySelectorAll('.pagedjs_page_content')) {
      const a = content.getBoundingClientRect();
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width === 0 && r.height === 0) continue;
          if (r.left < a.left - 1 || r.right > a.right + 1 || r.top < a.top - 1 || r.bottom > a.bottom + 1) {
            hits.push({ page: content.closest('.pagedjs_page').dataset.pageNumber, text: node.textContent.slice(0, 20) });
            break;
          }
        }
      }
    }
    return hits;
  };
  // Debug: every table row with its page, rect relative to the page, and the page content area.
  window.__t03rows = () => {
    const pages = [...document.querySelectorAll('.pagedjs_page')];
    return [...document.querySelectorAll('tr')].map((tr) => {
      const page = tr.closest('.pagedjs_page');
      const o = page.getBoundingClientRect();
      const area = page.querySelector('.pagedjs_page_content').getBoundingClientRect();
      const r = tr.getBoundingClientRect();
      const pt = (v) => Math.round(v * 0.75 * 100) / 100;
      return {
        page: pages.indexOf(page) + 1,
        text: tr.innerText.replace(/\s+/g, ' ').slice(0, 14),
        rect: [pt(r.left - o.left), pt(r.top - o.top), pt(r.right - o.left), pt(r.bottom - o.top)],
        cells: [...tr.children].map((c) => { const q = c.getBoundingClientRect(); return [c.innerText.slice(0, 8), pt(q.left - o.left), pt(q.top - o.top), pt(q.right - o.left), pt(q.bottom - o.top), [...c.getClientRects()].length]; }),
        trRects: [...tr.getClientRects()].length,
        area: [pt(area.left - o.left), pt(area.top - o.top), pt(area.right - o.left), pt(area.bottom - o.top)],
      };
    });
  };
})();
