import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, rulesSchema } from '@pdf-generator/contract';
import { generate } from '@pdf-generator/fake-data';
import { fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const read = (file: string) => readFileSync(join(directory, file), 'utf8');
const json = (file: string): unknown => JSON.parse(read(file));
const manifest = () => json('manifest.json') as Manifest;

// Independent Code 39 decoding table: alternating bars/spaces, narrow=1,
// wide=3. These are symbology patterns, not values read from the template.
const characters = new Map([
  ['111331311', '0'],
  ['311311113', '1'],
  ['113311113', '2'],
  ['313311111', '3'],
  ['111331113', '4'],
  ['311331111', '5'],
  ['113331111', '6'],
  ['111311313', '7'],
  ['311311311', '8'],
  ['113311311', '9'],
  ['131131311', '*'],
]);

const attr = (node: Element, name: string) =>
  node.attrs.find(attribute => attribute.name === name)?.value;
const hasClass = (node: Element, name: string) =>
  (attr(node, 'class') ?? '').split(/\s+/u).includes(name);

function elements(node: Node): Element[] {
  return [
    ...('tagName' in node ? [node] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(elements) : []),
  ];
}

function rawText(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(rawText).join('') : '';
}

function numericAttribute(node: Element, name: string): number {
  const value = attr(node, name);
  expect(value, `${node.tagName}.${name} must be numeric`).toMatch(
    /^\d+(?:\.\d+)?$/u,
  );
  return Number(value);
}

function decode(svg: Element): string {
  expect(svg.tagName).toBe('svg');
  expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
  const box = (attr(svg, 'viewBox') ?? '').trim().split(/\s+/u).map(Number);
  expect(box).toHaveLength(4);
  expect(box.slice(0, 3)).toEqual([0, 0, 16]);
  const height = box[3];
  expect(Number.isFinite(height)).toBe(true);
  expect(height).toBeGreaterThan(0);
  const bars = elements(svg).slice(1);
  expect(bars.map(bar => bar.tagName)).toEqual(Array(5).fill('rect'));
  expect(svg.childNodes.filter(node => 'tagName' in node)).toEqual(bars);
  // Sort by physical position: SVG drawing order must not define the oracle.
  const geometry = bars
    .map(bar => {
      expect(numericAttribute(bar, 'y')).toBe(0);
      expect(numericAttribute(bar, 'height')).toBe(height);
      return {
        x: numericAttribute(bar, 'x'),
        width: numericAttribute(bar, 'width'),
      };
    })
    .sort((a, b) => a.x - b.x);
  const widths: number[] = [];
  let end = 0;
  for (const [index, bar] of geometry.entries()) {
    if (index === 0) expect(bar.x).toBe(0);
    else widths.push(bar.x - end);
    widths.push(bar.width);
    end = bar.x + bar.width;
  }
  expect(end, 'one empty unit must remain for the inter-character gap').toBe(
    15,
  );
  expect(widths.every(width => width === 1 || width === 3)).toBe(true);
  expect(widths.filter(width => width === 3)).toHaveLength(3);
  const character = characters.get(widths.join(''));
  expect(character, `invalid Code 39 pattern ${widths.join('')}`).toBeDefined();
  if (character === undefined) throw new Error('Undecodable Code 39 character');
  return character;
}

function expectBarcode(
  record: Record<string, unknown>,
  template: string,
  file: string,
) {
  const document = parse(fill(template, record, { file }));
  const all = elements(document);
  const barcodes = all.filter(node => hasClass(node, 'barcode'));
  expect(barcodes, 'one mailing barcode must be printed').toHaveLength(1);
  const barcode = barcodes[0];
  if (!barcode) throw new Error('Missing mailing barcode');
  expect(barcode.tagName).toBe('div');
  expect(attr(barcode, 'data-gt')).toBe('barcode');
  expect(rawText(barcode).trim(), 'barcode GT text must remain empty').toBe('');
  const drawings = elements(barcode).slice(1);
  expect(
    drawings.filter(node => node.tagName !== 'svg' && node.tagName !== 'rect'),
  ).toEqual([]);
  const svgs = barcode.childNodes.filter(
    (node): node is Element => 'tagName' in node,
  );
  expect(svgs.map(node => node.tagName)).toEqual(Array(12).fill('svg'));
  const decoded = svgs.map(decode).join('');

  const digits = record.statementDigits;
  expect(digits, 'record must supply ten statement digits').toBeInstanceOf(
    Array,
  );
  if (!Array.isArray(digits)) throw new Error('Missing statementDigits');
  expect(digits).toHaveLength(10);
  expect(
    digits.every(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9),
  ).toBe(true);
  expect(decoded).toBe(`*${digits.join('')}*`);

  const siblings =
    barcode.parentNode && 'childNodes' in barcode.parentNode
      ? barcode.parentNode.childNodes.filter(
          (node): node is Element => 'tagName' in node,
        )
      : [];
  const label = siblings[siblings.indexOf(barcode) + 1];
  expect(
    label?.tagName,
    'human-readable number must immediately follow barcode',
  ).toBe('p');
  if (!label) throw new Error('Missing barcode label');
  expect(hasClass(label, 'barcode-text')).toBe(true);
  expect(attr(label, 'data-gt')).toBe('paragraph');
  expect(rawText(label).trim()).toBe(decoded);
  expect(all.filter(node => hasClass(node, 'barcode-text'))).toEqual([label]);
  const table = all.find(
    node => node.tagName === 'table' && hasClass(node, 'transactions'),
  );
  expect(table, 'barcode belongs before the transaction table').toBeDefined();
  if (!table) throw new Error('Missing transaction table');
  expect(all.indexOf(barcode)).toBeLessThan(all.indexOf(label));
  expect(all.indexOf(label)).toBeLessThan(all.indexOf(table));
  return digits.join('');
}

describe('bank statement mailing barcode, slice 2', () => {
  it('decodes the sample mailing barcode to its record and adjacent printed number without polluting barcode GT text', () => {
    const { files } = manifest();
    expectBarcode(
      json(files.sample) as Record<string, unknown>,
      read(files.template),
      files.template,
    );
  });

  it('decodes 100 seeded mailing barcodes to their varying record numbers instead of a hard-coded sample', () => {
    const { files } = manifest();
    const rules = rulesSchema.parse(json(files.rules));
    const template = read(files.template);
    const numbers = new Set<string>();
    for (let index = 0; index < 100; index++) {
      const seed = `t26-slice2-${index}`;
      const record = generate(rules, seed);
      expect(
        record.statementDigits,
        `${seed}: missing statementDigits`,
      ).toBeInstanceOf(Array);
      numbers.add(expectBarcode(record, template, files.template));
    }
    expect(
      numbers.size,
      'statement numbers must vary across seeds',
    ).toBeGreaterThan(1);
  });
});
