import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesSchema } from '@pdf-generator/contract';
import {
  generate,
  isCalendarDate,
  isValidBusinessId,
  isValidPhone,
  recordSchema,
} from '@pdf-generator/fake-data';
import { checkPack, fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const templateFile = 'templates/monthly-report.hbs';
const styleFile = 'styles/monthly-report.css';
const text = (file: string) => readFileSync(join(directory, file), 'utf8');
const json = (file: string): unknown => JSON.parse(text(file));
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

type Report = {
  company: string;
  businessId: string;
  period: { year: number; month: number };
  preparedBy: { name: string; phone: string };
  summary: string;
  highlights: string[];
  nextSteps: string[];
  remarks: string | null;
  figure: { caption: string; body: string };
  departments: {
    name: string;
    revenue: number;
    cost: number;
    headcount: number;
  }[];
  totals: {
    revenue: number;
    cost: number;
    headcount: number;
    costRatio: number;
  };
  projects: {
    title: string;
    owner: string;
    due: string;
    progress: number;
    status: string;
  }[];
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
const normalized = (node: Node) => content(node).replace(/\s+/g, ' ').trim();
const money = (value: number) => value.toLocaleString('en-US');
function required<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined)
    throw new Error('Expected a matched element or value');
  return value;
}

function expectPrintedRecord(template: string, record: Report) {
  const nodes = elements(parse(fill(template, record, { file: templateFile })));
  const blocks = (type: string) =>
    nodes.filter(node => attr(node, 'data-gt') === type);
  const paragraphs = blocks('paragraph').map(normalized);
  expect(blocks('title')).toHaveLength(1);
  expect(normalized(required(blocks('title')[0]))).toContain(record.company);
  expect(blocks('page_header')).toHaveLength(1);
  const header = normalized(required(blocks('page_header')[0]));
  expect(header).toContain(record.company);
  expect(header).toContain(
    `${record.period.year} 年 ${record.period.month} 月`,
  );
  expect(blocks('page_footer')).toHaveLength(1);
  expect(normalized(required(blocks('page_footer')[0]))).not.toBe('');
  expect(blocks('heading').map(normalized)).toEqual(
    expect.arrayContaining([
      '本月摘要',
      '重點事項',
      '各部門營運概況',
      '重點專案進度',
      '下月工作重點',
    ]),
  );
  expect(paragraphs).toContain(record.summary);
  expect(paragraphs).toContain(record.figure.body);
  expect(
    paragraphs.some(
      value =>
        value.includes(record.businessId) &&
        value.includes(record.preparedBy.name),
    ),
  ).toBe(true);
  expect(blocks('list_item').map(normalized)).toEqual([
    ...record.highlights,
    ...record.nextSteps,
  ]);
  expect(
    blocks('heading')
      .map(normalized)
      .filter(value => value === '備註'),
  ).toHaveLength(record.remarks === null ? 0 : 1);
  if (record.remarks !== null) expect(paragraphs).toContain(record.remarks);

  expect(blocks('image')).toHaveLength(1);
  expect(blocks('image')[0]?.tagName).toBe('img');
  const imageSrc = required(attr(required(blocks('image')[0]), 'src'));
  expect(posix.join(posix.dirname(templateFile), imageSrc)).toBe(
    'assets/figure.svg',
  );
  expect(blocks('caption').map(normalized)).toEqual([record.figure.caption]);

  const tables = blocks('table');
  expect(tables).toHaveLength(2);
  expect(tables.every(table => table.tagName === 'table')).toBe(true);
  const rows = (table: Element) =>
    elements(table)
      .filter(node => node.tagName === 'tr')
      .map(row =>
        elements(row)
          .filter(node => node.tagName === 'td')
          .map(normalized),
      )
      .filter(cells => cells.length > 0);
  const departmentRows = rows(required(tables[0]));
  const totalRows = departmentRows.filter(cells =>
    cells.some(cell => cell.includes('合計')),
  );
  expect(totalRows).toHaveLength(1);
  expect(departmentRows.filter(row => !totalRows.includes(row))).toEqual(
    record.departments.map(row => [
      row.name,
      money(row.revenue),
      money(row.cost),
      String(row.headcount),
    ]),
  );
  expect(totalRows[0]).toEqual([
    '合計',
    money(record.totals.revenue),
    money(record.totals.cost),
    String(record.totals.headcount),
  ]);
  expect(rows(required(tables[1]))).toEqual(
    record.projects.map(row => [
      row.title,
      row.owner,
      row.due,
      `${row.progress}%`,
      row.status,
    ]),
  );
  expect(
    [
      ...blocks('paragraph'),
      ...nodes.filter(node => node.tagName === 'td'),
    ].some(node => normalized(node).includes(`${record.totals.costRatio}%`)),
  ).toBe(true);
  for (const key of ['revenue', 'cost', 'headcount'] as const) {
    expect(record.totals[key]).toBe(
      record.departments.reduce((sum, row) => sum + row[key], 0),
    );
  }
  expect(record.totals.costRatio).toBe(
    Math.round((record.totals.cost / record.totals.revenue) * 1000) / 10,
  );
  expect(isValidBusinessId(record.businessId)).toBe(true);
  expect(isValidPhone(record.preparedBy.phone, 'landline')).toBe(true);
  for (const project of record.projects)
    expect(isCalendarDate(project.due)).toBe(true);
}

// Small CSS rule reader, retaining nested @page margin boxes without fixing
// the implementation's class names or running-element names.
function cssRules(source: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
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
    // A nested margin rule can follow @page declarations such as size/margin.
    // Those declarations are not part of the rule's selector.
    const selectorStart = Math.max(start, source.lastIndexOf(';', open) + 1);
    rules.push({
      selector: source.slice(selectorStart, open).trim(),
      body: source.slice(open + 1, end - 1),
    });
    start = end;
  }
  return rules;
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

describe('monthly report pack, slice 1', () => {
  it('passes the upload gate and prints every sample and seeded record without dropping or mislabelling report data', () => {
    const result = checkPack(readPack());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    const rules = rulesSchema.parse(json('data/rules.json'));
    const schema = recordSchema(rules);
    const records = [
      json('data/sample.json'),
      ...Array.from({ length: 50 }, (_, seed) => generate(rules, String(seed))),
    ];
    const template = text(templateFile);
    for (const [index, record] of records.entries()) {
      expect(
        schema.safeParse(record).success,
        index === 0 ? 'sample' : `seed ${index - 1}`,
      ).toBe(true);
      expectPrintedRecord(template, record as Report);
    }
    // Pin both conditional branches even if seeded blank frequencies change.
    const sample = records[0] as Report;
    expectPrintedRecord(template, { ...sample, remarks: null });
    expectPrintedRecord(template, {
      ...sample,
      remarks: '本月所有部門均已完成資料覆核。',
    });
    const paragraphTexts = (remarks: string | null) =>
      elements(
        parse(fill(template, { ...sample, remarks }, { file: templateFile })),
      )
        .filter(node => attr(node, 'data-gt') === 'paragraph')
        .map(normalized);
    expect(paragraphTexts('本月所有部門均已完成資料覆核。')).toEqual(
      expect.arrayContaining(paragraphTexts(null)),
    );
    expect(paragraphTexts('本月所有部門均已完成資料覆核。').length).toBe(
      paragraphTexts(null).length + 1,
    );
    expect(result.pack?.manifest.files.assets).toContain('assets/figure.svg');
  });

  it('keeps headers, footers and page numbers in running page margins with empty number/count slots instead of unmarked counters', () => {
    const css = text(styleFile).replace(/\/\*[\s\S]*?\*\//g, '');
    const nodes = elements(
      parse(
        fill(text(templateFile), json('data/sample.json') as Report, {
          file: templateFile,
        }),
      ),
    );
    const rules = cssRules(css);
    const declarations = (node: Element) =>
      [
        attr(node, 'style') ?? '',
        ...rules
          .filter(rule =>
            rule.selector.split(',').some(selector => matches(node, selector)),
          )
          .map(rule => rule.body),
      ].join(';');
    for (const [type, margin] of [
      ['page_header', 'top'],
      ['page_footer', 'bottom'],
      ['page_number', 'bottom'],
    ] as const) {
      const node = nodes.find(node => attr(node, 'data-gt') === type);
      expect(node, type).toBeDefined();
      const name = /position\s*:\s*running\(\s*([\w-]+)\s*\)/i.exec(
        declarations(required(node)),
      )?.[1];
      expect(name, `${type} must be a running element`).toBeDefined();
      const margins = rules
        .filter(rule => /^@page\b/.test(rule.selector))
        .flatMap(rule => cssRules(rule.body))
        .filter(rule => rule.selector.startsWith(`@${margin}-`));
      expect(
        margins.some(rule =>
          new RegExp(`content\\s*:\\s*element\\(\\s*${name}\\s*\\)`, 'i').test(
            rule.body,
          ),
        ),
      ).toBe(true);
    }
    const pageNumbers = nodes.filter(
      node => attr(node, 'data-gt') === 'page_number',
    );
    expect(pageNumbers).toHaveLength(1);
    const pageNumber = required(pageNumbers[0]);
    for (const attribute of ['data-gt-page-number', 'data-gt-page-count']) {
      const slots = elements(pageNumber).filter(
        node => attr(node, attribute) !== undefined,
      );
      expect(slots, attribute).toHaveLength(1);
      expect(required(slots[0]).tagName, attribute).toBe('span');
      expect(
        required(slots[0]).childNodes,
        `${attribute} must be empty`,
      ).toEqual([]);
    }
    // Distinct values catch swapped slots; the literal expectation catches
    // punctuation (including the unsupported full-width slash) and wording drift.
    const filledPageNumber = (node: Node): string => {
      if ('tagName' in node) {
        if (attr(node, 'data-gt-page-number') !== undefined) return '2';
        if (attr(node, 'data-gt-page-count') !== undefined) return '3';
      }
      return 'childNodes' in node
        ? node.childNodes.map(filledPageNumber).join('')
        : content(node);
    };
    expect(filledPageNumber(pageNumber).replace(/\s+/g, '')).toBe(
      '第2頁，共3頁',
    );
    const allCss = [
      css,
      ...nodes.map(node => attr(node, 'style') ?? ''),
      ...nodes.filter(node => node.tagName === 'style').map(content),
    ].join('\n');
    expect(allCss).not.toMatch(/counter\(\s*pages?\s*\)|@font-face\b/i);
    const families = [
      ...allCss.matchAll(/\b(font-family|font)\s*:\s*([^;}]+)/gi),
    ];
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      let names = required(family[2]);
      if (family[1]?.toLowerCase() === 'font') {
        const shorthand =
          /(?:\d*\.)?\d+(?:px|pt|em|rem|%)(?:\s*\/\s*[\d.]+(?:px|pt|em|rem|%)?)?\s+(.+)$/i.exec(
            names,
          );
        names = required(shorthand?.[1]);
      }
      for (const name of names.split(','))
        expect([
          'noto sans tc',
          'noto serif tc',
          'serif',
          'sans-serif',
        ]).toContain(name.replace(/["']/g, '').trim().toLowerCase());
    }
    for (const item of nodes.filter(
      node => attr(node, 'data-gt') === 'list_item',
    )) {
      let node: Node | null = item;
      const ancestors: Element[] = [];
      while (node && 'tagName' in node) {
        ancestors.push(node);
        node = node.parentNode;
      }
      const lists = ancestors.filter(node =>
        ['ul', 'ol'].includes(node.tagName),
      );
      expect(lists.length).toBeGreaterThan(0);
      expect(
        lists.some(list =>
          /list-style(?:-type)?\s*:\s*none\b/i.test(declarations(list)),
        ),
      ).toBe(true);
    }
  });

  it('keeps the packaged figure free of untracked SVG text and external dependencies', () => {
    const svg = text('assets/figure.svg').replace(/<!--[\s\S]*?-->/g, '');
    const nodes = elements(parse(svg));
    expect(nodes.some(node => node.tagName === 'svg')).toBe(true);
    expect(nodes.some(node => node.tagName.toLowerCase() === 'text')).toBe(
      false,
    );
    expect(svg).not.toMatch(/<!DOCTYPE|<!ENTITY|@import|@font-face/i);
    for (const node of nodes) {
      expect(['script', 'foreignObject']).not.toContain(node.tagName);
      for (const attribute of node.attrs) {
        if (['href', 'src'].includes(attribute.name))
          expect(attribute.value).toMatch(/^#/);
      }
    }
    for (const match of svg.matchAll(/url\(\s*["']?([^\s)"']+)/gi))
      expect(match[1]).toMatch(/^#/);
  });
});
