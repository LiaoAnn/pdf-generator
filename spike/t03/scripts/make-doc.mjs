// Writes public/doc.html: a fixed multi-page A4 Chinese document with data-gt blocks.
import { writeFileSync } from 'node:fs';

const para = [
  '本公司一一五年九月營業額為新臺幣三億四千二百萬元，較去年同期成長百分之十二點五，主要來自北區門市與線上通路。',
  '受颱風影響，中南部三處倉庫於九月十八日至二十日暫停出貨，延遲訂單共一千二百三十四筆，已於十月初全數補出。',
  '人事方面，本月新進員工十七人、離職九人，期末在職人數為四百八十八人。教育訓練共辦理六場，參訓率百分之九十三。',
  '資訊部門完成核心系統升級，停機時間由原訂的八小時縮短為五小時十五分，期間無資料遺失。',
];
const rare = '罕用字測試：堃、喆、犇、綉、峯、嫚、瑄、媺、霈、昇、峇里島、銹、裏、着、喫、龜、𡘙、㵾、𠀾、𩸽。';
const punct = '標點：，。、；：？！「」『』（）《》〈〉……——～％＄＃＠＆＊　全形空白。英數混排：ABC 123 abc, 2026/10/23 14:05。';

const blocks = [];
let n = 0;
const gt = (type, tag, html, cls = '') => {
  n += 1;
  blocks.push(`<${tag} data-gt="${type}" data-gt-id="b${n}"${cls ? ` class="${cls}"` : ''}>${html}</${tag}>`);
};

gt('title', 'h1', '台灣測試股份有限公司　一一五年九月營運月報');
gt('text', 'p', `統一編號：12345675　負責人：王大明　地址：臺北市中正區重慶南路一段122號　電話：(02)2311-3731`);
for (let i = 0; i < 3; i++) for (const p of para) gt('text', 'p', p);
gt('heading', 'h2', '一、罕用字與標點');
gt('text', 'p', rare);
gt('text', 'p', punct);
gt('text', 'p', '明體段落（替代新細明體）：本段使用思源宋體，檢查襯線字型的內嵌與抽取。' + para[0], 'serif');
gt('text', 'p', '楷體段落（替代標楷體）：本段使用霞鶩文楷，檢查楷體的內嵌與抽取。' + para[1], 'kai');
gt('heading', 'h2', '二、各門市營收明細');
const rows = [];
const stores = ['台北信義', '台北南港', '新北板橋', '桃園中壢', '新竹竹北', '台中西屯', '彰化員林', '台南永康', '高雄左營', '屏東潮州'];
for (let i = 0; i < 45; i++) {
  const s = stores[i % stores.length];
  const amt = (((i * 7919) % 90000) + 10000) * 13;
  rows.push(`<tr><td>${String(i + 1).padStart(3, '0')}</td><td>${s}${Math.floor(i / 10) + 1}號店</td><td class="num">${amt.toLocaleString('en-US')}</td><td>${i % 3 === 0 ? '☑ 達標' : '☐ 未達標'}</td></tr>`);
}
n += 1;
blocks.push(`<table data-gt="table" data-gt-id="b${n}"><thead><tr><th>編號</th><th>門市</th><th>營收（元）</th><th>狀態</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);
gt('heading', 'h2', '三、結語', 'chapter');
for (const p of para) gt('text', 'p', p);

const page = (extraCss, css = '/doc.css') => `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<title>T03 print spike</title>
<link rel="stylesheet" href="${css}">${extraCss}
<script src="/probe.js"></script>
<script src="/paged.polyfill.js"></script>
</head>
<body>
${blocks.join('\n')}
</body>
</html>
`;
writeFileSync(new URL('../public/doc.html', import.meta.url), page(''));
// Variant with the row-break fix under test.
const variants = {
  avoid: 'tr { break-inside: avoid; }',
  separate: 'table { border-collapse: separate; border-spacing: 0; }',
  tdavoid: 'td, th { break-inside: avoid; }',
  nopad: 'th, td { padding: 0 2mm; }',
};
// Fonts with patched cmaps (scripts/fix-cmap.mjs) and a symbol fallback.
writeFileSync(new URL('../public/doc-fixed.html', import.meta.url), page('', '/doc-fixed.css'));
for (const [k, css] of Object.entries(variants)) {
  writeFileSync(new URL(`../public/doc-${k}.html`, import.meta.url), page(`\n<style>${css}</style>`));
}
console.log(`blocks: ${n}`);
