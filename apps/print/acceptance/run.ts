// Acceptance run for T07: prints the fixed documents in this folder through a
// running print Worker and checks the PDFs. Not a unit test: it needs a
// Worker with a browser (local `wrangler dev`, or the deployed Worker).
//
//   PRINT_URL=http://127.0.0.1:8788 PRINT_TOKEN=… node acceptance/run.ts [outDir]
//
// Writes each PDF and a summary.json to outDir (default .wrangler/acceptance).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';

interface Case {
  file: string;
  orientation: 'portrait' | 'landscape';
  pages: number;
  /** Text each page must contain, whitespace removed. */
  pageText: string[][];
  /**
   * A table across pages: every row (its text, whitespace removed) is printed
   * exactly once and whole, and every page with rows has the header text
   * before its first row. Independent of where the pages break.
   */
  table?: { header: string; rows: string[] };
}

const tableRows = (html: string) =>
  [...html.matchAll(/<tr>(.*?)<\/tr>/g)]
    .map(m => (m[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s/g, ''))
    .filter(row => /^\d{3}/.test(row));

const cases: Case[] = [
  {
    file: 'portrait.html',
    orientation: 'portrait',
    pages: 3,
    pageText: [
      [
        '台灣測試股份有限公司一一五年九月營運月報',
        '本公司一一五年九月營業額為新臺幣三億四千二百萬元，較去年同期成長百分之十二點五。',
        '勾選項目：☑已完成☐未完成',
        '第1頁，共3頁',
      ],
      [
        '一、人事',
        '本月新進員工十七人、離職九人，期末在職人數為四百八十八人。',
        '第2頁，共3頁',
      ],
      [
        '二、資訊',
        '資訊部門完成核心系統升級，停機時間由原訂的八小時縮短為五小時十五分。',
        '第3頁，共3頁',
      ],
    ],
  },
  {
    file: 'landscape.html',
    orientation: 'landscape',
    pages: 1,
    pageText: [
      [
        '一一五年第三季各區營收（橫向）',
        '區域七月八月九月合計',
        '北區1,200,000',
      ],
    ],
  },
  {
    file: 'table.html',
    orientation: 'portrait',
    pages: 4,
    pageText: [[], ['二、各門市營收明細'], [], ['三、結語']],
    table: {
      header: '編號門市營收（元）狀態',
      rows: tableRows(
        await readFile(join(import.meta.dirname, 'table.html'), 'utf8'),
      ),
    },
  },
];

const base = process.env.PRINT_URL ?? 'http://127.0.0.1:8788';
const token = process.env.PRINT_TOKEN;
if (!token) throw new Error('set PRINT_TOKEN');
const outDir =
  process.argv[2] ?? join(import.meta.dirname, '../../../.wrangler/acceptance');
await mkdir(outDir, { recursive: true });

const results = [];
for (const c of cases) {
  const html = await readFile(join(import.meta.dirname, c.file), 'utf8');
  const started = Date.now();
  const response = await fetch(new URL('/print', base), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: c.orientation },
    }),
  });
  const ms = Date.now() - started;
  if (!response.ok) {
    results.push({
      file: c.file,
      ms,
      status: response.status,
      body: await response.text(),
      pass: false,
    });
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(join(outDir, c.file.replace(/\.html$/, '.pdf')), bytes);
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  const sizes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = (await pdf.getPage(n)).view;
    sizes.push([+(x1 - x0).toFixed(2), +(y1 - y0).toFixed(2)]);
  }
  const fonts = [
    ...new Set(
      [
        ...Buffer.from(bytes)
          .toString('latin1')
          .matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g),
      ].map(m => (m[1] ?? '').replace(/^[A-Z]{6}\+/, '')),
    ),
  ].sort();
  const [w, h] =
    c.orientation === 'portrait' ? [595.28, 841.89] : [841.89, 595.28];
  const missing = c.pageText.flatMap((expected, i) => {
    const page = (text[i] ?? '').replace(/\s/g, '');
    return expected
      .filter(s => !page.includes(s))
      .map(s => `page ${i + 1}: ${s}`);
  });
  const pages = text.map(t => t.replace(/\s/g, ''));
  const all = pages.join('');
  const table = c.table;
  const rowsOnce =
    !table ||
    (table.rows.length > 0 &&
      table.rows.every(row => all.split(row).length === 2));
  const headerOnEveryPage =
    !table ||
    pages.every(page => {
      const first = Math.min(
        ...table.rows.map(row => page.indexOf(row)).filter(at => at !== -1),
      );
      return first === Infinity || page.lastIndexOf(table.header, first) !== -1;
    });
  const checks = {
    pageCount: pdf.numPages === c.pages,
    header: response.headers.get('x-page-count') === String(pdf.numPages),
    size: sizes.every(
      ([sw = 0, sh = 0]) => Math.abs(sw - w) < 1 && Math.abs(sh - h) < 1,
    ),
    text: missing.length === 0,
    rowsOnce,
    headerOnEveryPage,
  };
  results.push({
    file: c.file,
    ms,
    status: response.status,
    xPageCount: response.headers.get('x-page-count'),
    pdfPages: pdf.numPages,
    sizes,
    fonts,
    text: text.map(t => t.replace(/\s/g, '')),
    missing,
    checks,
    pass: Object.values(checks).every(Boolean),
  });
  await pdf.loadingTask.destroy();
}
await writeFile(
  join(outDir, 'summary.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every(r => r.pass) ? 0 : 1;
