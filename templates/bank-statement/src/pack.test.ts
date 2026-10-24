import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, rulesSchema } from '@pdf-generator/contract';
import { generate } from '@pdf-generator/fake-data';
import { checkPack, fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Statement = {
  bank: {
    name: string;
    branch: string;
    branchPhone: string;
    businessId: string;
    address: string;
  };
  customer: { name: string; address: string };
  account: { number: number };
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  opening: number;
  transactions: {
    date: string;
    summary: string;
    withdrawal: number | null;
    deposit: number | null;
    balance: number;
    note: string | null;
  }[];
  totals: { deposits: number; withdrawals: number };
};

const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const read = (file: string) => readFileSync(join(directory, file), 'utf8');
const json = (file: string): unknown => JSON.parse(read(file));

// Read inside each test: an absent pack must fail tests, not test collection or tsc.
const manifest = () => json('manifest.json') as Manifest;

function readPack(): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(entry.parentPath, entry.name);
        return [
          relative(directory, path).split(sep).join('/'),
          readFileSync(path),
        ];
      }),
  );
}

function records() {
  const { files } = manifest();
  const rules = rulesSchema.parse(json(files.rules));
  return [
    { seed: 'preview sample', record: json(files.sample) as Statement },
    ...Array.from({ length: 100 }, (_, index) => {
      const seed = `t26-slice1-${index}`;
      return { seed, record: generate(rules, seed) as unknown as Statement };
    }),
  ];
}

// Decimal digit parsing is independent of the engine's arithmetic. Do not
// multiply binary floats by 100 to manufacture an apparently exact oracle.
function cents(value: number | null): bigint {
  if (value === null) return 0n;
  expect(typeof value).toBe('number');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Invalid nonnegative money: ${value}`);
  expect(Number.isInteger(value), 'statement amounts have no decimals').toBe(
    true,
  );
  return (
    BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  );
}

function expectBusinessId(id: string) {
  expect(id).toMatch(/^\d{8}$/);
  const digits = [...id].map(Number);
  const sum = digits.reduce((total, digit, index) => {
    const product = digit * ([1, 2, 1, 2, 1, 2, 4, 1][index] ?? 0);
    return total + Math.floor(product / 10) + (product % 10);
  }, 0);
  expect(sum % 10 === 0 || (digits[6] === 7 && (sum + 1) % 10 === 0)).toBe(
    true,
  );
}

function expectStatement(record: Statement) {
  for (const value of [
    record.bank.name,
    record.bank.branch,
    record.bank.address,
    record.customer.name,
    record.customer.address,
  ]) {
    expect(value).toEqual(expect.stringMatching(/\p{Script=Han}/u));
  }
  expectBusinessId(record.bank.businessId);
  expect(record.bank.branchPhone).toMatch(/^[\d -]+$/u);
  expect(record.bank.branchPhone.replace(/[ -]/gu, '')).toMatch(
    /^0(?:2[2-9]\d{7}|[3-8][2-9]\d{6}|4[2-9]\d{7}|(?:37|89|82)[2-9]\d{5}|49[2-9]\d{6}|836[2-9]\d{4})$/u,
  );
  expect(Number.isSafeInteger(record.account.number)).toBe(true);
  expect(String(record.account.number)).toMatch(/^[1-9]\d{13}$/);
  expect(record.periodStart).toBe('2026-09-01');
  expect(record.periodEnd).toBe('2026-09-30');
  expect(record.issueDate).toBe('2026-10-03');
  expect(record.transactions.length).toBeGreaterThanOrEqual(8);
  expect(record.transactions.length).toBeLessThanOrEqual(32);
  const dates = record.transactions.map(row => row.date);
  expect(dates).toEqual([...dates].sort());
  let balance = cents(record.opening);
  let deposits = 0n;
  let withdrawals = 0n;
  for (const [index, row] of record.transactions.entries()) {
    expect(row.date).toMatch(/^2026-09-(?:0[1-9]|[12]\d|30)$/);
    expect(row.summary).toEqual(expect.stringMatching(/\S/u));
    expect(row.note === null || typeof row.note === 'string').toBe(true);
    deposits += cents(row.deposit);
    withdrawals += cents(row.withdrawal);
    balance += cents(row.deposit) - cents(row.withdrawal);
    expect(cents(row.balance), `row ${index + 1} running balance`).toBe(
      balance,
    );
    expect(balance, `row ${index + 1} overdraft`).toBeGreaterThanOrEqual(0n);
  }
  expect(cents(record.totals.deposits)).toBe(deposits);
  expect(cents(record.totals.withdrawals)).toBe(withdrawals);
}

const attr = (node: Element, name: string) =>
  node.attrs.find(attribute => attribute.name === name)?.value;
const hasClass = (node: Element, name: string) =>
  (attr(node, 'class') ?? '').split(/\s+/u).includes(name);

function elements(
  node: Node,
  matches: (element: Element) => boolean,
): Element[] {
  const found: Element[] = [];
  if ('tagName' in node && matches(node)) found.push(node);
  if ('childNodes' in node) {
    for (const child of node.childNodes)
      found.push(...elements(child, matches));
  }
  return found;
}

function rawText(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(rawText).join(' ') : '';
}

const text = (node: Node) => rawText(node).replace(/\s+/gu, ' ').trim();
const tagged = (node: Node, tag: string) =>
  elements(node, element => element.tagName === tag);
const printed = (value: number | null) =>
  value === null ? '' : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function expectSummary(document: Node, label: string, value: number) {
  // Match label + value in a small containing element. This supports inline
  // labels and separate label/value cells without fixing an unpromised layout.
  const expected = new RegExp(
    `${label}\\s*[:：]?\\s*${printed(value)}(?![\\d,.])`,
    'u',
  );
  expect(
    elements(document, node => expected.test(text(node))).length,
    `${label} must print ${printed(value)}`,
  ).toBeGreaterThan(0);
}

describe('bank statement pack, slice 1', () => {
  it('passes the upload pack gate with the bank statement identity and portrait A4 page', () => {
    const result = checkPack(readPack());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pack?.manifest).toMatchObject({
      id: 'bank-statement',
      name: '銀行對帳單',
      page: { size: 'A4', orientation: 'portrait' },
    });
  });

  it('keeps the preview sample and 100 generated statements chronologically balanced with valid Taiwanese account data', () => {
    for (const { seed, record } of records()) {
      expectStatement(record);
      expect(record.transactions.length, seed).toBeGreaterThanOrEqual(8);
    }
  });

  it('varies batch row counts, includes long statements, and exercises blank and populated amount and note cells', () => {
    const batch = records()
      .slice(1)
      .map(({ record }) => record);
    const lengths = batch.map(record => record.transactions.length);
    expect(new Set(lengths).size).toBeGreaterThan(1);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(25);
    const rows = batch.flatMap(record => record.transactions);
    for (const field of ['withdrawal', 'deposit', 'note'] as const) {
      expect(new Set(rows.map(row => row[field] === null)), field).toEqual(
        new Set([true, false]),
      );
    }
  });

  it('prints every sample and generated transaction in order with exact formatted amounts, blank nulls, closing balance and totals', () => {
    const { files } = manifest();
    const template = read(files.template);
    for (const { seed, record } of records()) {
      const document = parse(fill(template, record, { file: files.template }));
      const tables = elements(
        document,
        node => node.tagName === 'table' && hasClass(node, 'transactions'),
      );
      expect(tables, seed).toHaveLength(1);
      const table = tables[0];
      if (!table) throw new Error(`Missing transaction table: ${seed}`);
      expect(attr(table, 'data-gt')).toBe('table');
      const heads = tagged(table, 'thead');
      expect(heads).toHaveLength(1);
      const head = heads[0];
      if (!head) throw new Error('Missing transaction header');
      expect(tagged(head, 'tr')).toHaveLength(1);
      expect(
        elements(head, node => ['th', 'td'].includes(node.tagName)).map(text),
      ).toEqual(['交易日期', '摘要', '支出', '存入', '餘額', '備註']);
      const bodies = tagged(table, 'tbody');
      expect(bodies).toHaveLength(1);
      const body = bodies[0];
      if (!body) throw new Error('Missing transaction body');
      const rows = tagged(body, 'tr');
      expect(rows, seed).toHaveLength(record.transactions.length);
      record.transactions.forEach((transaction, index) => {
        const row = rows[index];
        if (!row) throw new Error(`Missing transaction ${index}: ${seed}`);
        expect(
          tagged(row, 'td').map(text),
          `${seed}: row ${index + 1}`,
        ).toEqual([
          transaction.date,
          transaction.summary,
          printed(transaction.withdrawal),
          printed(transaction.deposit),
          printed(transaction.balance),
          transaction.note ?? '',
        ]);
      });
      const last = record.transactions.at(-1);
      if (!last) throw new Error('Statement has no transactions');
      expectSummary(document, '期末餘額', last.balance);
      expectSummary(document, '存入合計', record.totals.deposits);
      expectSummary(document, '支出合計', record.totals.withdrawals);
    }
  });

  it('keeps the marked SVG logo and all resources pack-local and customer-service text inside ground-truth blocks', () => {
    const { files } = manifest();
    const pack = readPack();
    const document = parse(
      fill(
        read(files.template),
        json(files.sample) as Record<string, unknown>,
        { file: files.template },
      ),
    );
    const logos = elements(
      document,
      node =>
        node.tagName === 'img' &&
        attr(node, 'data-gt') === 'image' &&
        (attr(node, 'src') ?? '').endsWith('.svg'),
    );
    expect(logos.length).toBeGreaterThan(0);
    for (const logo of logos) {
      const source = attr(logo, 'src') ?? '';
      expect(files.assets).toContain(source);
      expect(read(source)).toMatch(/<svg\b/u);
    }
    function expectLocal(reference: string, base: string) {
      if (reference.startsWith('#')) return;
      expect(reference).not.toMatch(/^(?:[a-z][a-z\d+.-]*:|\/)/i);
      const path = posix.normalize(
        posix.join(base, reference.split(/[?#]/u)[0] ?? ''),
      );
      expect(
        Object.hasOwn(pack, path),
        `missing local resource ${reference}`,
      ).toBe(true);
    }
    const css = files.styles.map(file => ({
      source: read(file),
      base: posix.dirname(file),
    }));
    for (const node of elements(document, () => true)) {
      for (const attribute of node.attrs) {
        if (['src', 'href', 'poster', 'data'].includes(attribute.name))
          expectLocal(attribute.value, '.');
        if (attribute.name === 'style')
          css.push({ source: attribute.value, base: '.' });
        expect(
          attribute.name,
          'srcset could bypass local-resource checks',
        ).not.toBe('srcset');
      }
      if (node.tagName === 'style') css.push({ source: text(node), base: '.' });
    }
    for (const { source, base } of css) {
      const clean = source.replace(/\/\*[\s\S]*?\*\//gu, '');
      expect(clean).not.toMatch(/@import\b/i);
      for (const match of clean.matchAll(
        /url\(\s*["']?([^\s"')]+)["']?\s*\)/giu,
      ))
        expectLocal(match[1] ?? '', base);
    }
    const services = elements(
      document,
      node => node.tagName === 'aside' && hasClass(node, 'service'),
    );
    expect(services).toHaveLength(1);
    const service = services[0];
    if (!service) throw new Error('Missing customer-service box');
    expect(text(service)).not.toBe('');
    function expectCovered(node: Node, covered = false) {
      const marked =
        covered || ('tagName' in node && attr(node, 'data-gt') !== undefined);
      if (node.nodeName === '#text' && 'value' in node && node.value.trim())
        expect(marked, `unmarked service text: ${node.value}`).toBe(true);
      if ('childNodes' in node) {
        for (const child of node.childNodes) expectCovered(child, marked);
      }
    }
    expectCovered(service);
    expect(
      elements(service, node => attr(node, 'data-gt') !== undefined).length,
    ).toBeGreaterThan(0);
  });
});
