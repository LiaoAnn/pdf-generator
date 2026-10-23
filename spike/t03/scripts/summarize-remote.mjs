// Summarises out/remote-*.json (the approved remote batch) into evidence/remote-summary.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const read = (n) => (existsSync(`out/remote-${n}.json`) ? readFileSync(`out/remote-${n}.json`, 'utf8') : null);
const json = (n) => {
  const s = read(n);
  try {
    return s && JSON.parse(s);
  } catch {
    return { raw: s.slice(0, 500) };
  }
};
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};
const benchSummary = (n) => {
  const j = json(n);
  if (!j?.lanes) return j;
  const results = j.lanes.flatMap((l) => l.results ?? []);
  const ok = results.filter((r) => !r.error);
  return {
    params: j.params,
    wallMs: j.wallMs,
    pdfs: j.pdfs,
    pdfsPerMinute: j.pdfsPerMinute,
    renderMs: stats(ok.map((r) => r.ms)),
    renderMsAfterFirst: stats(j.lanes.flatMap((l) => (l.results ?? []).slice(1).filter((r) => !r.error).map((r) => r.ms))),
    pages: [...new Set(ok.map((r) => r.pages))],
    overflowCounts: [...new Set(ok.map((r) => r.overflow))],
    pdfBytes: [...new Set(ok.map((r) => r.bytes))],
    errors: results.filter((r) => r.error).map((r) => r.error),
    lanes: j.lanes.map((l) => ({ launchMs: l.launchMs, launchError: l.launchError, renders: l.results?.length })),
  };
};
const runSummary = (n) => {
  const j = json(n);
  if (!j?.timings) return j;
  return {
    browserVersion: j.browserVersion,
    timings: j.timings,
    paged: { total: j.paged.total, performanceMs: j.paged.performanceMs, log: j.paged.log, failedFaces: j.paged.faces.filter((f) => f.status !== 'loaded') },
    snapshotPageCounts: Object.fromEntries(Object.entries(j.snapshots).map(([k, v]) => [k, v.pageCount])),
    doneAtLoad: j.doneAtLoad,
    doneAtFirstPage: j.doneAtFirstPage,
    overflow: j.overflow,
    fetched: j.fetched,
    console: j.console,
  };
};
const out = {
  limitsBefore: json('limits-before'),
  launch: json('launch'),
  runFixed: runSummary('run-fixed'),
  runOrig: runSummary('run-orig'),
  runBadFont: runSummary('run-badfont'),
  benchSeqIntercept: benchSummary('bench-seq-intercept'),
  benchSeqUrl: benchSummary('bench-seq-url'),
  benchTabs3Url: benchSummary('bench-tabs3-url'),
  benchBrowsers3Url: benchSummary('bench-browsers3-url'),
  reuse5s: json('reuse-5s'),
  reuse75s: json('reuse-75s'),
  limitsAfter: json('limits-after'),
  close: json('close'),
};
writeFileSync('evidence/remote-summary.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 200));
