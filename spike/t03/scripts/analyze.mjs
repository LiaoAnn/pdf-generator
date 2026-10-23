// Compare data-gt boxes from /run with glyph positions extracted from the printed PDF.
// Usage: node scripts/analyze.mjs out/run-local.json [snapshotName...]
import { readFileSync, writeFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
const run = JSON.parse(readFileSync(file, 'utf8'));
const pdfBytes = Buffer.from(run.pdfBase64, 'base64');
writeFileSync(file.replace(/\.json$/, '.pdf'), pdfBytes);

const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false, fontExtraProperties: true }).promise;
const items = [];
const fontsUsed = new Map();
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const [, , , ph] = page.view;
  await page.getOperatorList(); // loads fonts into commonObjs
  const tc = await page.getTextContent();
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const st = tc.styles[it.fontName];
    const font = page.commonObjs.get(it.fontName);
    const fontName = font?.name ?? it.fontName;
    fontsUsed.set(fontName, (fontsUsed.get(fontName) ?? '') + it.str);
    const size = Math.hypot(it.transform[2], it.transform[3]);
    const x = it.transform[4];
    const base = ph - it.transform[5];
    items.push({
      page: p,
      str: it.str,
      font: fontName,
      size,
      base,
      // Glyph box from the font's ascent/descent as pdf.js reports them (unreliable for some fonts).
      box: [x, base - st.ascent * size, x + it.width, base - st.descent * size],
      // Metric-free anchor: horizontal centre, a third of an em above the baseline.
      anchor: [x + it.width / 2, base - 0.35 * size],
    });
  }
}

const norm = (s) => s.replace(/\s+/g, '');
const fontReport = [...fontsUsed].map(([name, text]) => ({ name, chars: [...norm(text)].length, sample: norm(text).slice(0, 12) }));

function compare(snap) {
  const frags = snap.blocks.filter((b) => b.lines.length);
  const unmatched = [];
  const byFrag = new Map(frags.map((f) => [f, []]));
  for (const it of items) {
    const [cx, cy] = it.anchor;
    const f = frags.find((b) => b.page === it.page && cx >= b.box[0] - 1 && cx <= b.box[2] + 1 && cy >= b.box[1] - 1 && cy <= b.box[3] + 1);
    if (f) byFrag.get(f).push(it);
    else unmatched.push(it);
  }
  let maxDev = 0;
  let maxDevX = 0;
  let baselineOutside = 0;
  let matchedItems = 0;
  let textMismatch = 0;
  let textMismatchNfkc = 0;
  const diffs = [];
  const rows = [];
  for (const [f, its] of byFrag) {
    const pdfText = norm(its.map((i) => i.str).join(''));
    const ok = pdfText === norm(f.text);
    const okNfkc = pdfText.normalize('NFKC') === norm(f.text).normalize('NFKC');
    if (!ok) textMismatch++;
    if (!okNfkc) textMismatchNfkc++;
    if (!ok) diffs.push({ id: f.id, page: f.page, diff: [...pdfText].filter((c, i) => c !== [...norm(f.text)][i]).slice(0, 12).join('') });
    let dev = Infinity;
    if (its.length) {
      const u = (arr, i, fn) => fn(...arr.map((b) => b[i]));
      const lb = f.lines;
      const ib = its.map((i) => i.box);
      const dom = [u(lb, 0, Math.min), u(lb, 1, Math.min), u(lb, 2, Math.max), u(lb, 3, Math.max)];
      const pdf = [u(ib, 0, Math.min), u(ib, 1, Math.min), u(ib, 2, Math.max), u(ib, 3, Math.max)];
      dev = Math.max(...dom.map((v, i) => Math.abs(v - pdf[i])));
      maxDevX = Math.max(maxDevX, Math.abs(dom[0] - pdf[0]), Math.abs(dom[2] - pdf[2]));
      // Every glyph run's baseline must fall inside one of the block's DOM line boxes.
      for (const it of its) {
        matchedItems++;
        if (!lb.some((l) => it.base >= l[1] - 0.5 && it.base <= l[3] + 0.5 && it.anchor[0] >= l[0] - 0.5 && it.anchor[0] <= l[2] + 0.5)) baselineOutside++;
      }
      rows.push({ id: f.id, page: f.page, dom: dom.map((v) => +v.toFixed(2)), pdf: pdf.map((v) => +v.toFixed(2)), dev: +dev.toFixed(2), textOk: ok });
    } else {
      rows.push({ id: f.id, page: f.page, dev: null, textOk: ok });
    }
    maxDev = Math.max(maxDev, dev);
  }
  return {
    pageCount: snap.pageCount,
    fragments: frags.length,
    maxDevPt: +maxDev.toFixed(2),
    maxDevXPt: +maxDevX.toFixed(2),
    matchedItems,
    baselineOutside,
    textMismatch,
    textMismatchNfkc,
    diffs,
    unmatchedItems: unmatched.map((i) => `${i.page}:${i.str}`),
    rows,
  };
}

const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(run.snapshots);
const summary = {
  pdfPages: doc.numPages,
  pagedTotal: run.paged?.total,
  timings: run.timings,
  failedFaces: run.paged?.faces?.filter((f) => f.status !== 'loaded'),
  console: run.console,
  fonts: fontReport,
  snapshots: {},
};
const detail = {};
for (const n of names) {
  const c = compare(run.snapshots[n]);
  detail[n] = c;
  summary.snapshots[n] = { pageCount: c.pageCount, fragments: c.fragments, maxDevPt: c.maxDevPt, maxDevXPt: c.maxDevXPt, matchedItems: c.matchedItems, baselineOutside: c.baselineOutside, textMismatch: c.textMismatch, textMismatchNfkc: c.textMismatchNfkc, unmatched: c.unmatchedItems.length };
}
writeFileSync(file.replace(/\.json$/, '.analysis.json'), JSON.stringify({ summary, detail }, null, 2));
console.log(JSON.stringify(summary, null, 2));
