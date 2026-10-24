import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesSchema } from '@pdf-generator/contract';
import { generate } from '@pdf-generator/fake-data';
import { checkPack, fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const templateFile = 'templates/financial-statement.hbs';
const styleFile = 'styles/financial-statement.css';
const text = (file: string) => readFileSync(join(directory, file), 'utf8');
const json = (file: string): unknown => JSON.parse(text(file));
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Amounts = Record<'q1' | 'q2' | 'q3' | 'q4' | 'year' | 'prior', number>;
type Figures = Amounts & Record<'share' | 'priorShare' | 'ratio', number>;
type Statement = {
  company: string;
  businessId: string;
  fiscalYear: number;
  regions: Record<
    'north' | 'central' | 'south' | 'east',
    {
      name: string;
      customers: (Figures & { name: string; businessId: string })[];
      subtotal: Figures;
    }
  >;
  total: Amounts & { ratio: number };
  signers: Record<'chairman' | 'manager' | 'accountant' | 'preparer', string>;
};

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

function elements(node: Node): Element[] {
  return [
    ...('tagName' in node ? [node] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(elements) : []),
  ];
}
const attr = (node: Element, name: string) =>
  node.attrs.find(attribute => attribute.name === name)?.value;
function content(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(content).join('') : '';
}
// Preserve U+3000: collapsing all Unicode whitespace would hide a wrong
// separator in the running header/footer.
const printed = (node: Node) =>
  content(node)
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
const children = (node: Element, tag?: string) =>
  node.childNodes.filter(
    (child): child is Element =>
      'tagName' in child && (!tag || child.tagName === tag),
  );
function required<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined)
    throw new Error('Expected a matched element or value');
  return value;
}
const section = (table: Element, tag: string) => {
  const matches = children(table, tag);
  expect(matches, tag).toHaveLength(1);
  return required(matches[0]);
};
const cells = (row: Element) => children(row);
const shape = (cell: Element) => [
  printed(cell),
  Number(attr(cell, 'colspan') ?? 1),
  Number(attr(cell, 'rowspan') ?? 1),
];
const ordinary = (value: string) => [value, 1, 1];
const money = (value: number) => value.toLocaleString('en-US');
const figures = (value: Figures) => [
  money(value.q1),
  money(value.q2),
  money(value.q3),
  money(value.q4),
  money(value.year),
  value.share.toFixed(2),
  money(value.prior),
  value.priorShare.toFixed(2),
  value.ratio.toFixed(2),
];

const rules = rulesSchema.parse(json('data/rules.json'));
const records: [string, Statement][] = [
  ['sample', json('data/sample.json') as Statement],
  ...Array.from({ length: 50 }, (_, seed): [string, Statement] => [
    `seed ${seed}`,
    generate(rules, String(seed)) as Statement,
  ]),
];
function forEachPrinted(check: (nodes: Element[], record: Statement) => void) {
  const template = text(templateFile);
  for (const [label, record] of records) {
    try {
      check(
        elements(parse(fill(template, record, { file: templateFile }))),
        record,
      );
    } catch (cause) {
      throw new Error(`${label}: ${(cause as Error).message}`, { cause });
    }
  }
}
function tables(nodes: Element[]) {
  const result = nodes.filter(node => node.tagName === 'table');
  expect(result).toHaveLength(2);
  for (const table of result) expect(attr(table, 'data-gt')).toBe('table');
  return [required(result[0]), required(result[1])] as const;
}

// Keep selectors independent of implementation-specific class and running names.
function cssRules(source: string): { selector: string; body: string }[] {
  const result: { selector: string; body: string }[] = [];
  let start = 0;
  while (start < source.length) {
    const open = source.indexOf('{', start);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
      end++;
    }
    const selectorStart = Math.max(start, source.lastIndexOf(';', open) + 1);
    result.push({
      selector: source.slice(selectorStart, open).trim(),
      body: source.slice(open + 1, end - 1),
    });
    start = end;
  }
  return result;
}
function matches(node: Element, selector: string): boolean {
  const parts = selector.trim().split(/\s+/);
  const simple = parts.pop() ?? '';
  const tag = /^[\w-]+/.exec(simple)?.[0];
  if (tag && node.tagName !== tag) return false;
  for (const match of simple.matchAll(
    /([.#])([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g,
  )) {
    if (
      match[1] === '.' &&
      !attr(node, 'class')?.split(/\s+/).includes(required(match[2]))
    )
      return false;
    if (match[1] === '#' && attr(node, 'id') !== match[2]) return false;
    if (
      match[3] &&
      (attr(node, match[3]) === undefined ||
        (match[4] !== undefined && attr(node, match[3]) !== match[4]))
    )
      return false;
  }
  if (parts.length === 0) return true;
  let parent = node.parentNode;
  while (parent) {
    if ('tagName' in parent && matches(parent, parts.join(' '))) return true;
    parent = 'parentNode' in parent ? parent.parentNode : null;
  }
  return false;
}

describe('financial statement pack, slice 2', () => {
  it('passes the upload gate without missing assets or printed text outside ground-truth marks', () => {
    const result = checkPack(readPack());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('prints record-specific running blocks first and the exact title, period and unit for sample and 50 seeds', () => {
    forEachPrinted((nodes, record) => {
      const blocks = (type: string) =>
        nodes.filter(node => attr(node, 'data-gt') === type);
      expect(blocks('page_header').map(printed)).toEqual([
        `${record.company}　客戶別銷貨明細表`,
      ]);
      expect(blocks('page_footer').map(printed)).toEqual([
        `${record.company}　統一編號：${record.businessId}`,
      ]);
      const body = required(nodes.find(node => node.tagName === 'body'));
      expect(
        children(body)
          .slice(0, 2)
          .map(node => attr(node, 'data-gt')),
      ).toEqual(['page_header', 'page_footer']);
      expect(blocks('title').map(printed)).toEqual(['客戶別銷貨明細表']);
      expect(blocks('paragraph').map(printed)).toEqual([
        record.company,
        `中華民國 ${record.fiscalYear} 年 1 月 1 日至 12 月 31 日`,
        '單位：新臺幣元',
      ]);
      const order = nodes.filter(node =>
        ['title', 'paragraph'].includes(attr(node, 'data-gt') ?? ''),
      );
      expect(order.map(node => attr(node, 'data-gt'))).toEqual([
        'title',
        'paragraph',
        'paragraph',
        'paragraph',
      ]);
    });
  });

  it('keeps the three-level header spans and eleven explicit column widths for sample and 50 seeds', () => {
    forEachPrinted(nodes => {
      const [main] = tables(nodes);
      const columns = children(section(main, 'colgroup'), 'col');
      expect(columns).toHaveLength(11);
      for (const column of columns) {
        // Explicit widths stop Paged.js fragments from sizing columns from
        // different customer rows on each page.
        expect(
          `${attr(column, 'width') ?? ''};${attr(column, 'style') ?? ''}`,
        ).toMatch(/(?:^|width\s*:\s*)[1-9][\d.]*(?:%|px|pt|mm|cm)?/i);
      }
      const rows = children(section(main, 'thead'), 'tr');
      expect(rows).toHaveLength(3);
      for (const row of rows)
        expect(cells(row).every(cell => cell.tagName === 'th')).toBe(true);
      expect(rows.map(row => cells(row).map(shape))).toEqual([
        [
          ['客戶名稱', 1, 3],
          ['統一編號', 1, 3],
          ['本年度', 6, 1],
          ['上年度', 2, 2],
          ['比較', 1, 2],
        ],
        [
          ['上半年', 2, 1],
          ['下半年', 2, 1],
          ['全年', 2, 1],
        ],
        [
          '第一季',
          '第二季',
          '第三季',
          '第四季',
          '金額',
          '占比（%）',
          '金額',
          '占比（%）',
          '本年/上年（%）',
        ].map(ordinary),
      ]);
      expect(children(main, 'tfoot')).toHaveLength(0);
    });
  });

  it('prints every region, customer, subtotal and final total in order with grouped amounts and two-decimal percentages for sample and 50 seeds', () => {
    forEachPrinted((nodes, record) => {
      const [main] = tables(nodes);
      const expected = (['north', 'central', 'south', 'east'] as const).flatMap(
        key => {
          const region = record.regions[key];
          return [
            [[region.name, 11, 1]],
            ...region.customers.map(customer =>
              [customer.name, customer.businessId, ...figures(customer)].map(
                ordinary,
              ),
            ),
            [
              [`${region.name}小計`, 2, 1],
              ...figures(region.subtotal).map(ordinary),
            ],
          ];
        },
      );
      expected.push([
        ['總計', 2, 1],
        ...figures({ ...record.total, share: 100, priorShare: 100 }).map(
          ordinary,
        ),
      ]);
      const rows = children(section(main, 'tbody'), 'tr');
      expect(rows.map(row => cells(row).map(shape))).toEqual(expected);
      expect(elements(main).filter(node => node.tagName === 'tr')).toHaveLength(
        expected.length + 3,
      );
    });
  });

  it('prints all four signer roles and their corresponding names after the sales table for sample and 50 seeds', () => {
    forEachPrinted((nodes, record) => {
      const [, signatures] = tables(nodes);
      const head = children(section(signatures, 'thead'), 'tr');
      expect(head).toHaveLength(1);
      expect(
        cells(required(head[0])).every(cell => cell.tagName === 'th'),
      ).toBe(true);
      expect(head.map(row => cells(row).map(shape))).toEqual([
        ['負責人', '經理人', '會計主管', '製表人'].map(ordinary),
      ]);
      const body = children(section(signatures, 'tbody'), 'tr');
      expect(body.map(row => cells(row).map(shape))).toEqual([
        [
          record.signers.chairman,
          record.signers.manager,
          record.signers.accountant,
          record.signers.preparer,
        ].map(ordinary),
      ]);
      expect(
        elements(signatures).filter(node => node.tagName === 'tr'),
      ).toHaveLength(2);
    });
  });

  it('uses landscape pages, fixed table layout and matching running margin boxes without generated text or custom fonts', () => {
    const css = text(styleFile).replace(/\/\*[\s\S]*?\*\//g, '');
    const nodes = elements(
      parse(fill(text(templateFile), required(records[0])[1])),
    );
    const rules = cssRules(css);
    const declarations = (node: Element) =>
      [
        ...rules
          .filter(rule =>
            rule.selector.split(',').some(selector => matches(node, selector)),
          )
          .map(rule => rule.body),
        attr(node, 'style') ?? '',
      ].join(';');
    const pages = rules.filter(rule => /^@page\b/i.test(rule.selector));
    expect(
      pages.some(rule =>
        /size\s*:\s*(?:A4\s+landscape|landscape\s+A4)\s*(?:;|$)/i.test(
          rule.body,
        ),
      ),
    ).toBe(true);
    expect(declarations(tables(nodes)[0])).toMatch(
      /table-layout\s*:\s*fixed\b/i,
    );
    for (const [type, margin] of [
      ['page_header', 'top'],
      ['page_footer', 'bottom'],
    ] as const) {
      const node = required(nodes.find(node => attr(node, 'data-gt') === type));
      const name = required(
        /position\s*:\s*running\(\s*([\w-]+)\s*\)/i.exec(
          declarations(node),
        )?.[1],
      );
      const margins = pages
        .flatMap(page => cssRules(page.body))
        .filter(rule => rule.selector.startsWith(`@${margin}-`));
      expect(
        margins.some(rule =>
          new RegExp(`content\\s*:\\s*element\\(\\s*${name}\\s*\\)`, 'i').test(
            rule.body,
          ),
        ),
      ).toBe(true);
    }
    const allCss = [
      css,
      ...nodes.map(node => attr(node, 'style') ?? ''),
      ...nodes.filter(node => node.tagName === 'style').map(content),
    ].join('\n');
    expect(allCss).not.toMatch(/@font-face\b|\bcounters?\s*\(/i);
    for (const match of allCss.matchAll(/\bcontent\s*:\s*([^;}]+)/gi)) {
      expect(required(match[1]).trim()).toMatch(
        /^(?:none|""|''|element\(\s*[\w-]+(?:\s*,\s*(?:first|start|last|first-except))?\s*\))$/i,
      );
    }
    const families = [
      ...allCss.matchAll(/\b(font-family|font)\s*:\s*([^;}]+)/gi),
    ];
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      let names = required(family[2]);
      if (family[1]?.toLowerCase() === 'font')
        names = required(
          /(?:\d*\.)?\d+(?:px|pt|em|rem|%)(?:\s*\/\s*[\d.]+(?:px|pt|em|rem|%)?)?\s+(.+)$/i.exec(
            names,
          )?.[1],
        );
      for (const name of names.split(','))
        expect([
          'noto sans tc',
          'noto serif tc',
          'serif',
          'sans-serif',
        ]).toContain(name.replace(/["']/g, '').trim().toLowerCase());
    }
    // This document has no lists: adding one introduces browser-generated
    // markers that are absent from the marked text.
    expect(
      nodes.filter(node => ['ul', 'ol', 'li'].includes(node.tagName)),
    ).toHaveLength(0);
    expect(allCss).not.toMatch(/display\s*:\s*list-item\b/i);
  });
});
