// The Word-equivalent reference for T10's side-by-side check: the minimal
// example filled with a record, as a .docx with the settings word.css
// imitates (A4, Word's default margins, 新細明體 → Noto Serif TC 12 pt,
// Table Grid). LibreOffice converts it to the PDF Word would make:
//   node src/word-reference.ts <out.docx>   (the sample record)
//   soffice --headless --convert-to pdf <out.docx>
// The content comes from the filled template, so the two documents hold the
// same text; the layout settings are Word's, written here in twips.
import { writeFileSync } from 'node:fs';
import { fill } from '@pdf-generator/template-tools';
import { strToU8, type Zippable, zipSync } from 'fflate';
import { type DefaultTreeAdapterTypes as Html, parse } from 'parse5';
import { packFiles } from './index.ts';

// 1 mm = 1440 / 25.4 twips. Keep in step with word.css (a test checks).
const page = { width: 11906, height: 16838 };
const margin = { top: 1440, right: 1797, bottom: 1440, left: 1797 };
const headerDistance = 850; // 15 mm
const footerDistance = 992; // 17.5 mm
const textWidth = page.width - margin.left - margin.right;
const cellPadding = 108; // 5.4 pt
const symbols = /[☐☑]/u;

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Runs of `text`, with ☑ ☐ in Noto Sans Symbols 2 as the pack prints them. */
function runs(text: string, properties = ''): string {
  return (text.match(/[☐☑]+|[^☐☑]+/gu) ?? [])
    .map(part => {
      const font = symbols.test(part)
        ? '<w:rFonts w:ascii="Noto Sans Symbols 2" w:hAnsi="Noto Sans Symbols 2" w:eastAsia="Noto Sans Symbols 2"/>'
        : '';
      const rPr = font + properties;
      return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`;
    })
    .join('');
}

function paragraph(text: string, style?: string, properties = ''): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}${runs(text, properties)}</w:p>`;
}

const children = (node: Html.ParentNode): Html.Element[] =>
  node.childNodes.filter((child): child is Html.Element => 'tagName' in child);
const attribute = (element: Html.Element, name: string) =>
  element.attrs.find(attr => attr.name === name)?.value;
const hasClass = (element: Html.Element, name: string) =>
  (attribute(element, 'class') ?? '').split(/\s+/).includes(name);

/** Text as the browser lays it out: HTML whitespace (not 　) collapsed. */
function text(node: Html.Node): string {
  if (node.nodeName === '#text') return (node as Html.TextNode).value;
  if (!('childNodes' in node)) return '';
  return node.childNodes
    .map(text)
    .join('')
    .replace(/[ \t\n\r\f]+/g, ' ')
    .replace(/^ | $/g, '');
}

function table(element: Html.Element): string {
  const columns = children(element)
    .filter(child => child.tagName === 'colgroup')
    .flatMap(children);
  const fixed = columns.map(col =>
    hasClass(col, 'name') || hasClass(col, 'role') ? 0.3 : undefined,
  );
  const rest = 1 - fixed.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  const free = fixed.filter(part => part === undefined).length;
  const widths = fixed.map(part =>
    Math.round(textWidth * (part ?? rest / free)),
  );
  const rows = children(element)
    .filter(child => ['thead', 'tbody', 'tfoot'].includes(child.tagName))
    .flatMap(group =>
      children(group).map(row => ({ header: group.tagName === 'thead', row })),
    )
    .map(({ header, row }) => {
      const trPr = `<w:trPr><w:cantSplit/>${header ? '<w:tblHeader/>' : ''}</w:trPr>`;
      const cells = children(row)
        .map(
          (cell, i) =>
            `<w:tc><w:tcPr><w:tcW w:w="${widths[i] ?? 0}" w:type="dxa"/></w:tcPr>${paragraph(text(cell), 'TableText')}</w:tc>`,
        )
        .join('');
      return `<w:tr>${trPr}${cells}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}

/** The body's blocks as Word paragraphs and tables; the footer apart. */
function convert(body: Html.Element): { body: string; footer: string } {
  let footer = '';
  const blocks: string[] = [];
  const visit = (element: Html.Element) => {
    const tag = element.tagName;
    if (hasClass(element, 'word-footer')) footer = text(element);
    else if (hasClass(element, 'word-title'))
      blocks.push(paragraph(text(element), 'Title'));
    else if (/^h[1-3]$/.test(tag))
      blocks.push(paragraph(text(element), `Heading${tag[1]}`));
    else if (tag === 'table') blocks.push(table(element));
    else if (tag === 'ul' || tag === 'ol') children(element).forEach(visit);
    else if (hasClass(element, 'pair') || tag === 'li')
      blocks.push(paragraph(text(element), 'LeftAligned'));
    else blocks.push(paragraph(text(element)));
  };
  children(body).forEach(visit);
  return { body: blocks.join(''), footer };
}

const styles = xml(`<w:styles xmlns:w="${w}">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Serif TC" w:hAnsi="Noto Serif TC" w:eastAsia="Noto Serif TC" w:cs="Noto Serif TC"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="LeftAligned"><w:name w:val="Left Aligned"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="60"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="360"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="180"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="180"/><w:jc w:val="left"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${cellPadding}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${cellPadding}" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${cellPadding}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${cellPadding}" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`);

/** The minimal example's document for `record`, as a .docx. */
export function wordReferenceDocx(record: unknown): Uint8Array {
  const files = packFiles();
  const template = new TextDecoder().decode(
    files['template.hbs'] as Uint8Array,
  );
  const html = parse(fill(template, record, { file: 'template.hbs' }));
  const htmlElement = children(html).find(child => child.tagName === 'html');
  const body =
    htmlElement && children(htmlElement).find(c => c.tagName === 'body');
  if (!body) throw new Error('the filled template has no <body>');
  const content = convert(body);

  const document = xml(
    `<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body>${content.body}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="${margin.top}" w:right="${margin.right}" w:bottom="${margin.bottom}" w:left="${margin.left}" w:header="${headerDistance}" w:footer="${footerDistance}" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  const footer = xml(
    `<w:ftr xmlns:w="${w}" xmlns:r="${r}">${paragraph(content.footer, 'Footer')}</w:ftr>`,
  );
  const contentTypes = xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  );
  const relationships = (entries: [string, string, string][]) =>
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`,
    );
  const officeDocument = `${r}/officeDocument`;
  // A fixed time: the same record gives the same bytes.
  const mtime = new Date('2026-01-01T00:00:00Z');
  const parts: Zippable = Object.fromEntries(
    Object.entries({
      '[Content_Types].xml': contentTypes,
      '_rels/.rels': relationships([
        ['rId1', officeDocument, 'word/document.xml'],
      ]),
      'word/document.xml': document,
      'word/styles.xml': styles,
      'word/footer1.xml': footer,
      'word/_rels/document.xml.rels': relationships([
        ['rIdStyles', `${r}/styles`, 'styles.xml'],
        ['rIdFooter', `${r}/footer`, 'footer1.xml'],
      ]),
    }).map(([path, part]) => [path, [strToU8(part), { mtime }]]),
  );
  return zipSync(parts);
}

if (import.meta.main) {
  const [out] = process.argv.slice(2);
  if (!out) {
    console.error('usage: node src/word-reference.ts <out.docx>');
    process.exit(2);
  }
  const sample = JSON.parse(
    new TextDecoder().decode(packFiles()['data/sample.json'] as Uint8Array),
  );
  writeFileSync(out, wordReferenceDocx(sample));
}
