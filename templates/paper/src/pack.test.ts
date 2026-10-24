import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { generate, recordSchema } from '@pdf-generator/fake-data';
import { checkPack, fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { katexFonts } from './build.ts';
import { type FormulaSlot, formulas } from './formulas.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Paper = {
  journal: { name: string; volume: number; issue: number; year: number };
  title: string;
  authors: { name: string; affiliation: string }[];
  received: string;
  accepted: string;
  grant: { school: number; serial: number };
  abstract: string;
  abstractEn: string;
  keywords: string;
  intro: string[];
  related: { cite: string; text: string }[];
  method: string[];
  training: string[];
  experiments: string[];
  conclusion: string[];
  references: {
    kind: 'zh' | 'en';
    year: number;
    volume: number;
    issue: number;
    pages: string;
    authorZh: string;
    coauthorZh: string | null;
    titleZh: string;
    venueZh: string;
    authorsEn: string;
    titleEn: string;
    venueEn: string;
  }[];
} & Record<FormulaSlot, number>;

const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const templateFile = 'templates/paper.hbs';
const read = (path: string) => readFileSync(join(directory, path), 'utf8');
const rules = rulesSchema.parse(JSON.parse(read('data/rules.json')));
const schema = recordSchema(rules);
const records = Array.from({ length: 100 }, (_, index) => {
  const seed = `t25-slice2-${index}`;
  const data = generate(rules, seed);
  return { seed, data, record: data as unknown as Paper };
});
const slots: FormulaSlot[] = ['eq1', 'eq2', 'eq3', 'eq4'];

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
const hasClass = (node: Element, name: string) =>
  (attr(node, 'class') ?? '').split(/\s+/u).includes(name);
const blocks = (node: Node, type?: string) =>
  elements(node).filter(element =>
    type
      ? attr(element, 'data-gt') === type
      : attr(element, 'data-gt') !== undefined,
  );
function rawText(node: Node): string {
  if ('value' in node && node.nodeName === '#text') return node.value;
  return 'childNodes' in node ? node.childNodes.map(rawText).join('') : '';
}
// Preserve full-width spacing and punctuation while ignoring HTML indentation.
const text = (node: Node) =>
  rawText(node)
    .replace(/[\t\n\r ]+/gu, ' ')
    .trim();
const rendered = () => {
  const template = read(templateFile);
  return records.map(fixture => ({
    ...fixture,
    document: parse(fill(template, fixture.data, { file: templateFile })),
  }));
};
const pairs = (nodes: Element[]) =>
  nodes.map(node => [attr(node, 'data-gt'), text(node)]);

function footnotes(record: Paper): string[] {
  const author = record.authors[0];
  if (!author) throw new Error('A paper must have a corresponding author');
  return [
    `收稿日期：${record.received}；接受日期：${record.accepted}。`,
    `* 通訊作者：${author.name}，${author.affiliation}。`,
    `† 本研究由國科會計畫 NSTC 113-2221-E-${record.grant.school}-${record.grant.serial} 補助。`,
    '1 本文實驗程式碼與資料集將於論文接受後公開。',
  ];
}

describe('paper pack, slice 2', () => {
  it('accepts the shipped WOFF2 pack with matching manifest assets and a reproducible preview sample', () => {
    // Regression: missing assets/marks, invalid CSS, or a hand-edited sample
    // that is no longer a record the seeded engine can produce; a stale
    // manifest or leftover TTF files ships the obsolete font payload.
    const files = readPack();
    const manifest = manifestSchema.parse(JSON.parse(read('manifest.json')));
    const expectedFonts = katexFonts.map(face => `fonts/${face}.woff2`).sort();
    expect(manifest.files.assets?.slice().sort()).toEqual(expectedFonts);
    expect(
      Object.keys(files).filter(path => /\.(?:ttf|woff)$/iu.test(path)),
    ).toEqual([]);
    expect(
      Object.keys(files)
        .filter(path => path.startsWith('fonts/'))
        .sort(),
    ).toEqual(expectedFonts);
    const result = checkPack(files);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    const sample: unknown = JSON.parse(read('data/sample.json'));
    expect(schema.safeParse(sample).success).toBe(true);
    expect(sample).toEqual(generate(rules, 'sample'));
  });

  it('accepts 100 generated samples without hiding failures behind the preview record', () => {
    // Regression: nullable coauthors or shorter arrays break a branch which
    // happens not to be taken by the committed sample.
    const files = readPack();
    for (const { seed, data } of records) {
      expect(schema.safeParse(data).success, seed).toBe(true);
      const result = checkPack({
        ...files,
        'data/sample.json': JSON.stringify(data),
      });
      expect(result.issues, seed).toEqual([]);
      expect(result.ok, seed).toBe(true);
    }
  }, 60_000);

  it('keeps the complete built template within the upload text-file limit', () => {
    // Regression: the equation branches fit alone, but adding the paper body
    // makes the actual deliverable impossible to upload. The limit is private
    // in apps/web/src/templates/limits.ts, so use its documented 64 KiB value.
    expect(Buffer.byteLength(read(templateFile), 'utf8')).toBeLessThanOrEqual(
      65536,
    );
  });

  it('prints header, footnotes, author calls and bilingual abstracts in reading order', () => {
    // Regression: an author is omitted, * or † falls outside its GT box,
    // punctuation changes, or the English abstract loses its language marker.
    for (const { seed, record: r, document } of rendered()) {
      const all = blocks(document);
      const firstBodyHeading = all.findIndex(
        node => attr(node, 'data-gt') === 'heading' && text(node) === '1　緒論',
      );
      expect(pairs(all.slice(0, firstBodyHeading)), seed).toEqual([
        [
          'page_header',
          `${r.journal.name}　第 ${r.journal.volume} 卷第 ${r.journal.issue} 期（${r.journal.year}）`,
        ],
        ...footnotes(r).map(value => ['footnote', value]),
        ['title', `${r.title}†`],
        ...r.authors.flatMap((author, index) => [
          ['paragraph', `${author.name}${index === 0 ? '*' : ''}`],
          ['paragraph', author.affiliation],
        ]),
        ['heading', '摘要'],
        ['paragraph', r.abstract],
        ['label', '關鍵詞：'],
        ['field', r.keywords],
        ['heading', 'Abstract'],
        ['paragraph', r.abstractEn],
      ]);
      expect(blocks(document, 'page_header')).toHaveLength(1);
      const containers = elements(document).filter(node =>
        hasClass(node, 'footnotes'),
      );
      expect(containers, seed).toHaveLength(1);
      expect(
        containers.flatMap(node => blocks(node, 'footnote')).map(text),
      ).toEqual(footnotes(r));
      expect(blocks(document, 'footnote')).toHaveLength(4);
      const superscripts = all.slice(0, firstBodyHeading).flatMap(node =>
        elements(node)
          .filter(element => element.tagName === 'sup')
          .map(text),
      );
      expect(superscripts).toEqual(['†', '*']);
      const english = blocks(document, 'paragraph').find(
        node => text(node) === r.abstractEn,
      );
      expect(english).toBeDefined();
      if (english) expect(attr(english, 'lang')).toBe('en');
    }
  });

  it('keeps every body paragraph and selected equation in the intended column reading order', () => {
    // Regression: each/first/last puts an equation in every paragraph, drops
    // one, or moves the footnote call outside the introductory paragraph.
    for (const { seed, record: r, document } of rendered()) {
      const columns = elements(document).filter(node =>
        hasClass(node, 'columns'),
      );
      expect(columns, seed).toHaveLength(1);
      const body = columns.flatMap(node => blocks(node));
      const referenceHeading = body.findIndex(
        node => text(node) === '參考文獻',
      );
      const heading = (value: string) => ['heading', value];
      const paragraph = (value: string) => ['paragraph', value];
      const equation = (slot: FormulaSlot) => [
        'formula',
        formulas[slot][r[slot]],
      ];
      expect(
        body
          .slice(0, referenceHeading + 1)
          .map(node => [
            attr(node, 'data-gt'),
            attr(node, 'data-gt') === 'formula'
              ? attr(node, 'data-gt-latex')
              : text(node),
          ]),
        seed,
      ).toEqual([
        heading('1　緒論'),
        ...r.intro.map((value, index) =>
          paragraph(value + (index === 0 ? '1' : '')),
        ),
        heading('2　相關研究'),
        ...r.related.map(item => paragraph(`${item.cite}指出，${item.text}`)),
        heading('3　研究方法'),
        heading('3.1　模型架構'),
        ...r.method.flatMap((value, index) => [
          paragraph(value),
          ...(index === 0 ? [equation('eq1')] : []),
        ]),
        equation('eq2'),
        heading('3.2　模型訓練'),
        ...r.training.map(paragraph),
        equation('eq3'),
        heading('4　實驗結果'),
        ...r.experiments.flatMap((value, index) => [
          paragraph(value),
          ...(index === 0 ? [equation('eq4')] : []),
        ]),
        heading('5　結論'),
        ...r.conclusion.map(paragraph),
        heading('參考文獻'),
      ]);
      expect(
        blocks(document, 'formula').map(node => attr(node, 'data-gt-latex')),
      ).toEqual(slots.map(slot => formulas[slot][r[slot]]));
      const intro = body.find(node => attr(node, 'data-gt') === 'paragraph');
      expect(intro).toBeDefined();
      if (intro)
        expect(
          elements(intro)
            .filter(node => node.tagName === 'sup')
            .map(text),
        ).toEqual(['1']);
      for (const item of r.related) expect(item.cite).toMatch(/\[[1-5]\]/u);
    }
  });

  it('numbers references from one and prints only the chosen language and optional coauthor', () => {
    // Regression: zero-based/constant numbering, leaking the unused language
    // fields, or a dangling 、 when the Chinese coauthor is null.
    for (const { seed, record: r, document } of rendered()) {
      const references = blocks(document, 'reference');
      expect(references, seed).toHaveLength(r.references.length);
      r.references.forEach((reference, index) => {
        const node = references[index];
        if (!node) throw new Error(`${seed}: missing reference ${index + 1}`);
        const prefix = `[${index + 1}] `;
        const expected =
          reference.kind === 'zh'
            ? `${prefix}${reference.authorZh}${reference.coauthorZh === null ? '' : `、${reference.coauthorZh}`}（${reference.year}）。${reference.titleZh}${reference.venueZh}，${reference.volume}(${reference.issue})，${reference.pages}。`
            : `${prefix}${reference.authorsEn} (${reference.year}). ${reference.titleEn} ${reference.venueEn}, ${reference.volume}(${reference.issue}), ${reference.pages}.`;
        expect(text(node), `${seed}: reference ${index + 1}`).toBe(expected);
        if (reference.kind === 'en') expect(attr(node, 'lang')).toBe('en');
      });
    }
  });

  it('renders varied author/reference counts, every equation option and both bibliography branches', () => {
    // Regression: a fixed array size/constant selector silently collapses the
    // fixture set while all individual records still look plausible.
    const fixtures = rendered();
    expect(
      new Set(fixtures.map(({ record }) => record.authors.length)),
    ).toEqual(new Set([2, 3, 4]));
    expect(
      new Set(
        fixtures.map(({ document }) => blocks(document, 'reference').length),
      ),
    ).toEqual(new Set([5, 6, 7, 8]));
    for (const [index, slot] of slots.entries()) {
      expect(
        new Set(
          fixtures.map(({ document }) => {
            const node = blocks(document, 'formula')[index];
            return node ? attr(node, 'data-gt-latex') : undefined;
          }),
        ),
        slot,
      ).toEqual(new Set(formulas[slot]));
    }
    const references = fixtures.flatMap(({ record }) => record.references);
    expect(new Set(references.map(item => item.kind))).toEqual(
      new Set(['zh', 'en']),
    );
    expect(
      new Set(
        references
          .filter(item => item.kind === 'zh')
          .map(item => item.coauthorZh === null),
      ),
    ).toEqual(new Set([true, false]));
  });

  it('places running footnotes only in the first page bottom margin', () => {
    // Regression: using the default @page repeats the four footnotes on every
    // page, or leaving them in normal flow shifts the entire paper body.
    const css = read('styles/paper.css').replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(css).toMatch(
      /\.footnotes\s*\{[^{}]*position\s*:\s*running\(\s*footnotes\s*\)/u,
    );
    const start = /@page\s*:first\s*\{/u.exec(css);
    expect(start).not.toBeNull();
    if (!start) return;
    let end = start.index + start[0].length;
    let depth = 1;
    for (; end < css.length && depth > 0; end++) {
      if (css[end] === '{') depth++;
      if (css[end] === '}') depth--;
    }
    const first = css.slice(start.index, end);
    expect(first).toMatch(
      /@bottom-(?:left|center|right)\s*\{[^{}]*content\s*:\s*element\(\s*footnotes\s*\)/u,
    );
    expect(css.slice(0, start.index) + css.slice(end)).not.toMatch(
      /element\(\s*footnotes\s*\)/u,
    );
  });
});
