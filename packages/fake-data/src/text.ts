// Filler text from the package's own phrase lists: Traditional Chinese
// (Taiwan usage), English, or Chinese mixed with English terms, numbers and
// units. Text is whole clauses (subject + predicate, or a metric and its
// value) picked to hit an exact length in characters. Every string here is
// BMP, so `.length` counts characters.
import type { Rng } from './random.ts';

const zhSubjects = [
  '本月營收',
  '門市業績',
  '客戶滿意度',
  '專案進度',
  '系統效能',
  '人力成本',
  '庫存數量',
  '訂單數',
  '退貨率',
  '網站流量',
  '會員人數',
  '新產品',
  '業務部',
  '研發團隊',
  '採購金額',
  '營運成本',
  '出貨時程',
  '品質檢驗',
  '教育訓練',
  '資訊安全',
  '供應商',
  '物流費用',
  '行銷活動',
  '年度預算',
  '設備維護',
  '本季',
];
const zhPredicates = [
  '持續成長',
  '較上月提升',
  '略有下滑',
  '符合預期',
  '仍待改善',
  '已完成驗收',
  '需要追蹤',
  '維持穩定',
  '明顯增加',
  '逐步回升',
  '依計畫執行',
  '提前達成目標',
  '已送交審核',
  '尚在評估中',
  '請各單位配合',
  '詳見附件',
  '由專人處理',
  '大幅縮短',
  '有效降低',
  '待下次會議討論',
  '列入年度重點',
  '完成',
  '延後',
  '調整',
];
// Short replies, so every length from 1 up has a clause.
const zhShort = [
  '好',
  '妥',
  '可',
  '完成',
  '確認',
  '同意',
  '知悉',
  '已完成',
  '待確認',
  '請配合',
  '已收到',
  '無異議',
];

const termSubjects = [
  'KPI 達成率',
  'ERP 系統',
  'CRM 名單',
  'API 回應',
  'App 下載量',
  'Excel 報表',
  'PDF 檔案',
  'Email 通知',
  'iPhone 用戶',
  'Line 群組',
  'Google 表單',
];
// `#` is a digit, drawn when the clause is used.
const metrics = [
  '平均回應時間為 ### ms',
  '平均回應時間為 #### ms',
  '每月流量為 ## GB',
  '每月流量為 ### GB',
  '運送距離為 ## km',
  '運送距離為 ### km',
  '包裹重量為 #.# kg',
  '包裹重量為 ## kg',
  '附件大小為 # MB',
  '附件大小為 ## MB',
  '達成率為 ##%',
  '成長率為 #%',
  '毛利率為 ##.#%',
  'CPU 使用率為 ##%',
  '硬碟容量剩 ### GB',
];

const enSubjects = [
  'Sales',
  'Costs',
  'Orders',
  'Revenue',
  'The team',
  'Inventory',
  'The sales team',
  'Our customer service',
  'The quarterly report',
  'Monthly revenue',
  'The project schedule',
  'The new product',
  'The finance department',
  'Order volume',
  'Each branch office',
  'Delivery time',
  'The marketing budget',
];
const enPredicates = [
  'rose',
  'fell',
  'grew',
  'held steady',
  'improved',
  'was reviewed',
  'remains stable',
  'needs further review',
  'met the target',
  'was approved',
  'declined slightly',
  'will be updated',
  'is on track',
];
const enComplements = [
  'this month',
  'in the third quarter',
  'as expected',
  'after the audit',
  'for all departments',
  'by the end of the year',
  'compared with last month',
  'according to the plan',
];
const enShort = [
  'A',
  'OK',
  'Yes',
  'Done',
  'Noted',
  'Agreed',
  'Pending',
  'Approved',
  'Confirmed',
];

/** Clauses grouped by length. */
type Clauses = Map<number, string[]>;

function byLength(clauses: string[]): Clauses {
  const map: Clauses = new Map();
  for (const clause of clauses) {
    map.set(clause.length, [...(map.get(clause.length) ?? []), clause]);
  }
  return map;
}

const pairs = (subjects: string[], predicates: string[], join: string) =>
  subjects.flatMap(subject =>
    predicates.map(predicate => subject + join + predicate),
  );

const zhClauses = byLength([
  ...zhShort,
  ...pairs(zhSubjects, zhPredicates, ''),
]);
const mixedClauses = byLength([
  ...pairs(termSubjects, zhPredicates, ''),
  ...metrics,
]);
const enClauses = byLength([
  ...enShort,
  ...pairs(enSubjects, enPredicates, ' '),
  ...pairs(pairs(enSubjects, enPredicates, ' '), enComplements, ' '),
]);

interface Style {
  /** Plain clauses, and those holding an English term or number (mixed only). */
  plain: Clauses;
  terms?: Clauses;
  /** Punctuation after a clause that is not the last, and between units. */
  marks: string[];
  end: string;
  gap: string;
}

const styles: Record<'zh' | 'en' | 'mixed', Style> = {
  zh: { plain: zhClauses, marks: ['，', '，', '；', '。'], end: '。', gap: '' },
  mixed: {
    plain: zhClauses,
    terms: mixedClauses,
    marks: ['，', '，', '；', '。'],
    end: '。',
    gap: '',
  },
  en: { plain: enClauses, marks: ['.'], end: '.', gap: ' ' },
};

function pickClause(rng: Rng, clauses: Clauses, length: number): string {
  const clause = rng.pick(clauses.get(length) ?? []);
  return clause.replace(/#/g, (_, at: number) =>
    String(rng.int(at > 0 && /\d/.test(clause.charAt(at - 1)) ? 0 : 1, 9)),
  );
}

/**
 * Filler text of exactly `length` (≥ 1) characters: clauses, each followed by
 * a mark, the last by the end mark. Mixed text starts with a clause holding a
 * term or number whenever one fits, then uses one for about half the clauses.
 */
export function fillerText(
  rng: Rng,
  lang: 'zh' | 'en' | 'mixed',
  length: number,
): string {
  const style = styles[lang];
  // Clause lengths 1..9 all exist, so any remainder of 2 or more can be
  // filled: a clause of remainder - 1 characters, or another split.
  if (length === 1) return pickClause(rng, style.plain, 1);
  let out = '';
  let left = length;
  for (let first = true; ; first = false) {
    const terms =
      style.terms !== undefined && (first || rng.chance(0.5))
        ? style.terms
        : undefined;
    const pool = (n: number) =>
      terms?.has(n) ? terms : style.plain.has(n) ? style.plain : undefined;
    // Last clause: it fills what is left, unless that is long enough to split.
    const last = pool(left - 1);
    if (last !== undefined && (left <= 30 || rng.chance(0.3))) {
      return `${out + pickClause(rng, last, left - 1)}${style.end}`;
    }
    // Otherwise a clause, its mark and the gap, leaving room for another
    // clause of a few characters (at least 1 when nothing longer fits).
    const room = (n: number) => left - n - 1 - style.gap.length;
    const choose = (clauses: Clauses) => {
      const lengths = [...clauses.keys()].sort((a, b) => a - b);
      const roomy = lengths.filter(n => n >= 4 && room(n) >= 6);
      return roomy.length > 0 ? roomy : lengths.filter(n => room(n) >= 2);
    };
    const withTerm = terms === undefined ? [] : choose(terms);
    const options = withTerm.length > 0 ? withTerm : choose(style.plain);
    const n = rng.pick(options);
    const mark = rng.pick(style.marks);
    out +=
      pickClause(rng, withTerm.length > 0 && terms ? terms : style.plain, n) +
      mark +
      style.gap;
    left -= n + 1 + style.gap.length;
  }
}
