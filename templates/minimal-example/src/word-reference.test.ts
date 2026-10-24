import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordCss } from '@pdf-generator/pack-spec';
import { fill } from '@pdf-generator/template-tools';
import { unzipSync } from 'fflate';
import { type DefaultTreeAdapterTypes as Html, parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { create } from 'xmlbuilder2';
import { packFiles } from './index.ts';
import { wordReferenceDocx } from './word-reference.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const decoder = new TextDecoder();
const files = packFiles();
function packText(path: string): string {
  const value = files[path];
  expect(value, `missing pack file: ${path}`).toBeDefined();
  return typeof value === 'string' ? value : decoder.decode(value);
}
const sample = JSON.parse(packText('data/sample.json'));
const template = packText('template.hbs');
const wordNamespace =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
type Xml = ReturnType<typeof create>;

function xmlPart(zip: Record<string, Uint8Array>, path: string): Xml {
  expect(zip[path], `missing OOXML part: ${path}`).toBeDefined();
  return create(decoder.decode(zip[path])).root();
}

function elements(node: Xml, name: string, recursive = true): Xml[] {
  return node.filter(child => child.node.nodeName === name, false, recursive);
}

function one(node: Xml, name: string): Xml {
  const matches = elements(node, name);
  expect(matches, `expected one ${name}`).toHaveLength(1);
  return matches[0] as Xml;
}

function attr(node: Xml, name: string): string | null {
  // XMLBuilder exposes a DOM node; these helpers only receive elements.
  return (
    node.node as unknown as { getAttribute(name: string): string | null }
  ).getAttribute(name);
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function paragraphText(node: Xml): string {
  return normalize(
    elements(node, 'w:t')
      .map(run => run.node.textContent ?? '')
      .join(''),
  );
}

function htmlElements(node: Html.Node): Html.Element[] {
  if (!('childNodes' in node)) return [];
  return node.childNodes.flatMap(child => [
    ...('tagName' in child ? [child] : []),
    ...htmlElements(child),
  ]);
}

function htmlText(node: Html.Node): string {
  if (node.nodeName === '#text') return (node as Html.TextNode).value;
  return 'childNodes' in node ? node.childNodes.map(htmlText).join('') : '';
}

function gtType(node: Html.Element): string | undefined {
  return node.attrs.find(attribute => attribute.name === 'data-gt')?.value;
}

function filled(record: unknown): Html.Element[] {
  return htmlElements(parse(fill(template, record)));
}

function assertBodyText(document: Xml, record: unknown): void {
  const body = one(document, 'w:body');
  // Walk paragraphs outside tables; runs may split a word or combine a label/field.
  let remaining = normalize(
    elements(body, 'w:p', false).map(paragraphText).join(' '),
  );
  for (const block of filled(record).filter(node => {
    const type = gtType(node);
    return type !== undefined && type !== 'table' && type !== 'page_footer';
  })) {
    const expected = normalize(htmlText(block));
    expect(
      remaining.startsWith(expected),
      `next printed block: ${expected}; remaining: ${remaining}`,
    ).toBe(true);
    remaining = remaining.slice(expected.length).trimStart();
  }
  expect(remaining, 'unexpected body text after the final pack block').toBe('');
}

function assertTables(document: Xml, record: unknown): void {
  const htmlTables = filled(record).filter(node => gtType(node) === 'table');
  const tables = elements(document, 'w:tbl');
  expect(tables).toHaveLength(htmlTables.length);
  for (const [tableIndex, htmlTable] of htmlTables.entries()) {
    const expected = htmlElements(htmlTable)
      .filter(node => node.tagName === 'tr')
      .map(row =>
        htmlElements(row)
          .filter(node => node.tagName === 'th' || node.tagName === 'td')
          .map(cell => normalize(htmlText(cell))),
      );
    const actual = elements(tables[tableIndex] as Xml, 'w:tr', false).map(row =>
      elements(row, 'w:tc', false).map(cell =>
        normalize(elements(cell, 'w:p').map(paragraphText).join(' ')),
      ),
    );
    expect(
      actual,
      `table ${tableIndex}: row/column text including checkbox glyphs`,
    ).toEqual(expected);
  }
}

function cssPageGeometry() {
  const css = wordCss().replace(/\/\*[\s\S]*?\*\//g, '');
  const page = css.slice(css.indexOf('@page'));
  const margin = page.match(/\bmargin\s*:\s*([^;]+);/);
  expect(margin, 'canonical @page margin declaration').not.toBeNull();
  const values = (margin?.[1] ?? '')
    .trim()
    .split(/\s+/)
    .map(value => {
      expect(value).toMatch(/^\d+(?:\.\d+)?mm$/);
      return (Number.parseFloat(value) * 1440) / 25.4;
    });
  expect(values.length).toBeGreaterThanOrEqual(1);
  expect(values.length).toBeLessThanOrEqual(4);
  const [top = 0, right = top, bottom = top, left = right] = values;
  function distance(box: string, property: string) {
    const block = page.match(new RegExp(`@${box}\\s*\\{([^}]*)\\}`));
    const value = block?.[1]?.match(
      new RegExp(`${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)mm\\s*;`),
    );
    expect(value, `${box} ${property} in canonical CSS`).not.toBeNull();
    return (Number(value?.[1]) * 1440) / 25.4;
  }
  return {
    top,
    right,
    bottom,
    left,
    header: distance('top-center', 'padding-top'),
    footer: distance('bottom-center', 'padding-bottom'),
  };
}

function expectTwips(node: Xml, name: string, expected: number) {
  const value = attr(node, `w:${name}`);
  expect(value, `missing w:${name}`).not.toBeNull();
  expect(
    Math.abs(Number(value) - expected),
    `w:${name}: expected ${expected} twips, got ${value}`,
  ).toBeLessThanOrEqual(2);
}

describe('Word reference for the minimal example', () => {
  it('writes a usable sample DOCX when an author runs the documented Node CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'word-reference-'));
    try {
      const output = join(directory, 'reference.docx');
      const result = spawnSync(
        process.execPath,
        ['src/word-reference.ts', output],
        {
          cwd: packageDir,
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const zip = unzipSync(new Uint8Array(readFileSync(output)));
      assertBodyText(xmlPart(zip, 'word/document.xml'), sample);
      assertTables(xmlPart(zip, 'word/document.xml'), sample);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('packages a Word document with reachable document, styles and footer parts', () => {
    const zip = unzipSync(wordReferenceDocx(sample));
    const types = xmlPart(zip, '[Content_Types].xml');
    const rootRels = xmlPart(zip, '_rels/.rels');
    const document = xmlPart(zip, 'word/document.xml');
    xmlPart(zip, 'word/styles.xml');
    expect(
      (document.node as unknown as { namespaceURI: string }).namespaceURI,
    ).toBe(wordNamespace);
    const office = elements(rootRels, 'Relationship').find(rel =>
      attr(rel, 'Type')?.endsWith('/officeDocument'),
    );
    expect(office).toBeDefined();
    expect(attr(office as Xml, 'Target')).toMatch(/^\/?word\/document\.xml$/);
    const rels = xmlPart(zip, 'word/_rels/document.xml.rels');
    const relationships = elements(rels, 'Relationship');
    const styles = relationships.find(rel =>
      attr(rel, 'Type')?.endsWith('/styles'),
    );
    expect(styles).toBeDefined();
    expect(posix.resolve('/word', attr(styles as Xml, 'Target') ?? '')).toBe(
      '/word/styles.xml',
    );
    const footerReference = one(document, 'w:footerReference');
    const footerRel = relationships.find(
      rel => attr(rel, 'Id') === attr(footerReference, 'r:id'),
    );
    expect(footerRel).toBeDefined();
    expect(attr(footerRel as Xml, 'Type')).toMatch(/\/footer$/);
    const footerPath = posix
      .resolve('/word', attr(footerRel as Xml, 'Target') ?? '')
      .slice(1);
    xmlPart(zip, footerPath);
    const overrides = elements(types, 'Override');
    for (const [path, contentType] of [
      [
        'word/document.xml',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      ],
      [
        'word/styles.xml',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
      ],
      [
        footerPath,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
      ],
    ]) {
      expect(
        overrides.some(
          part =>
            attr(part, 'PartName') === `/${path}` &&
            attr(part, 'ContentType') === contentType,
        ),
      ).toBe(true);
    }
  });

  it('keeps one A4 portrait section synchronized with canonical CSS margins and header/footer distances', () => {
    const document = xmlPart(
      unzipSync(wordReferenceDocx(sample)),
      'word/document.xml',
    );
    const section = one(document, 'w:sectPr');
    const size = one(section, 'w:pgSz');
    expectTwips(size, 'w', 11906);
    expectTwips(size, 'h', 16838);
    expect(attr(size, 'w:orient')).not.toBe('landscape');
    const margins = one(section, 'w:pgMar');
    for (const [name, value] of Object.entries(cssPageGeometry()))
      expectTwips(margins, name, value);
  });

  it('sets the default Latin and East Asian runs to Noto Serif TC at 12pt', () => {
    const styles = xmlPart(
      unzipSync(wordReferenceDocx(sample)),
      'word/styles.xml',
    );
    const candidates = [
      ...elements(styles, 'w:docDefaults'),
      ...elements(styles, 'w:style').filter(
        style => attr(style, 'w:styleId') === 'Normal',
      ),
    ];
    const fonts = candidates.flatMap(candidate =>
      elements(candidate, 'w:rFonts'),
    );
    expect(
      fonts.some(
        font =>
          attr(font, 'w:ascii') === 'Noto Serif TC' &&
          attr(font, 'w:eastAsia') === 'Noto Serif TC',
      ),
    ).toBe(true);
    const sizes = candidates.flatMap(candidate => elements(candidate, 'w:sz'));
    expect(sizes.some(size => attr(size, 'w:val') === '24')).toBe(true);
  });

  it('gives each table complete 0.5pt grid borders and 5.4pt horizontal cell margins', () => {
    const zip = unzipSync(wordReferenceDocx(sample));
    const document = xmlPart(zip, 'word/document.xml');
    const styles = xmlPart(zip, 'word/styles.xml');
    const tables = elements(document, 'w:tbl');
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const properties = one(table, 'w:tblPr');
      const styleId = elements(properties, 'w:tblStyle')[0];
      const style = elements(styles, 'w:style').find(
        candidate =>
          attr(candidate, 'w:styleId') ===
          (styleId ? attr(styleId, 'w:val') : undefined),
      );
      const inherited = style ? elements(style, 'w:tblPr')[0] : undefined;
      const borders =
        elements(properties, 'w:tblBorders')[0] ??
        (inherited && elements(inherited, 'w:tblBorders')[0]);
      expect(
        borders,
        'table grid borders, direct or in the applied style',
      ).toBeDefined();
      for (const edge of [
        'top',
        'bottom',
        'left',
        'right',
        'insideH',
        'insideV',
      ]) {
        const border = one(borders as Xml, `w:${edge}`);
        expect(attr(border, 'w:val')).toBe('single');
        expect(attr(border, 'w:sz')).toBe('4');
      }
      const margins =
        elements(properties, 'w:tblCellMar')[0] ??
        (inherited && elements(inherited, 'w:tblCellMar')[0]);
      for (const cell of elements(table, 'w:tc')) {
        const cellMargins = elements(cell, 'w:tcMar')[0] ?? margins;
        expect(
          cellMargins,
          'cell margins, direct or inherited from table',
        ).toBeDefined();
        for (const side of ['left', 'right']) {
          const margin = one(cellMargins as Xml, `w:${side}`);
          expectTwips(margin, 'w', 108);
          expect(attr(margin, 'w:type')).toBe('dxa');
        }
      }
    }
  });

  it('preserves every filled non-table block in reading order and moves only the page footer to a footer part', () => {
    const zip = unzipSync(wordReferenceDocx(sample));
    const document = xmlPart(zip, 'word/document.xml');
    assertBodyText(document, sample);
    const footerText = filled(sample)
      .filter(node => gtType(node) === 'page_footer')
      .map(node => normalize(htmlText(node)))
      .join(' ');
    const footerParts = Object.keys(zip).filter(
      path =>
        /^word\/.*\.xml$/.test(path) &&
        create(decoder.decode(zip[path])).root().node.nodeName === 'w:ftr',
    );
    expect(footerParts.length).toBeGreaterThan(0);
    expect(
      footerParts.map(path => paragraphText(xmlPart(zip, path))).join(' '),
    ).toBe(footerText);
    expect(paragraphText(document)).not.toContain(footerText);
  });

  it('preserves table headers, row/column order and checked/unchecked glyphs from the filled pack', () => {
    assertTables(
      xmlPart(unzipSync(wordReferenceDocx(sample)), 'word/document.xml'),
      sample,
    );
  });

  it('produces identical bytes for the same record even across ZIP timestamp boundaries', async () => {
    const first = wordReferenceDocx(sample);
    // ZIP DOS timestamps have two-second resolution; immediate calls miss clock-dependent output.
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(wordReferenceDocx(structuredClone(sample))).toEqual(first);
  });

  it('uses the supplied company and attendee count instead of hard-coding the sample record', () => {
    for (const attendees of [
      [],
      [
        { name: '測試甲', title: '顧問', present: false },
        { name: '測試乙', title: '主管', present: true },
        { name: '測試丙', title: '工程師', present: false },
        { name: '測試丁', title: '秘書', present: true },
      ],
    ]) {
      const record = {
        ...structuredClone(sample),
        company: '海風替代資料有限公司',
        attendees,
        confirmed: false,
      };
      const document = xmlPart(
        unzipSync(wordReferenceDocx(record)),
        'word/document.xml',
      );
      assertBodyText(document, record);
      assertTables(document, record);
      expect(elements(one(document, 'w:tbl'), 'w:tr', false)).toHaveLength(
        attendees.length + 1,
      );
      expect(paragraphText(document)).not.toContain(sample.company);
    }
  });
});
