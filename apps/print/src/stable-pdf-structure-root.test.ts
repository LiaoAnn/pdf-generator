import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { stablePdf } from './stable-pdf.ts';

const documentUrl =
  'http://127.0.0.1:46341/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/index.html';
const source = readFileSync(
  new URL('./test-fixtures/untitled-print-a.pdf', import.meta.url),
).toString('latin1');

// Append a valid incremental section. Original object offsets remain valid;
// the last trailer selects the effective catalog and Info independently.
function incremental(
  objects: [number, string][],
  trailer = '/Root 31 0 R /Info 1 0 R',
): Uint8Array {
  let text = source;
  const offsets: [number, number][] = [];
  for (const [number, body] of objects) {
    offsets.push([number, text.length]);
    text += `${number} 0 obj\n${body}\nendobj\n`;
  }
  const xref = text.length;
  text += 'xref\n';
  for (const [number, offset] of offsets) {
    text += `${number} 1\n${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const previous = /startxref\s+(\d+)/.exec(source)?.[1];
  text += `trailer\n<< /Size 110 /Prev ${previous} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function bodyAt(bytes: Uint8Array, number: number): string {
  const text = Buffer.from(bytes).toString('latin1');
  const header = `\n${number} 0 obj`;
  const offset = text.lastIndexOf(header);
  expect(offset, `missing object ${number}`).toBeGreaterThanOrEqual(0);
  const start = offset + header.length;
  return text.slice(start, text.indexOf('endobj', start));
}

test.each([
  [
    'unreferenced StructElem',
    '<< /Type /StructElem /S /TD /P 11 0 R /ID (node123) /A << /O /Table /Headers [(node456)] >> >>',
  ],
  [
    'ordinary dictionary',
    '<< /ID (node123) /Headers [(node456)] /IDTree 101 0 R >>',
  ],
  [
    'unreferenced structure root',
    '<< /Type /StructTreeRoot /K 102 0 R /IDTree 101 0 R >>',
  ],
])(
  'leaves %s and its name tree untouched outside the catalog structure tree',
  (_name, body) => {
    const input = incremental([
      [100, body],
      [101, '<< /Kids [103 0 R] >>'],
      [
        102,
        '<< /Type /StructElem /S /TD /P 100 0 R /ID (node456) /A << /O /Table /Headers [(node123)] >> >>',
      ],
      [103, '<< /Names [(node456) 102 0 R] >>'],
    ]);
    const output = stablePdf(input, documentUrl);
    for (const number of [100, 101, 102, 103]) {
      expect
        .soft(bodyAt(output, number), `object ${number}`)
        .toBe(bodyAt(input, number));
    }
    // Scoping must not be implemented by disabling real normalization.
    expect(bodyAt(output, 12)).not.toContain('/ID (node');
    expect(bodyAt(output, 11)).not.toContain('/IDTree');
    expect(bodyAt(output, 29).trim()).toBe('null');
    expect(bodyAt(output, 30).trim()).toBe('null');
    expect(bodyAt(output, 1)).not.toMatch(/\/(CreationDate|ModDate|Title)\b/);
  },
);

test('a catalog IDTree outside StructTreeRoot is preserved rather than followed', () => {
  const catalog =
    '<< /Type /Catalog /Pages 10 0 R /StructTreeRoot 11 0 R /IDTree 101 0 R >>';
  const input = incremental(
    [
      [100, catalog],
      [101, '<< /Names [(private) 3 0 R] >>'],
    ],
    '/Root 100 0 R /Info 1 0 R',
  );
  const output = stablePdf(input, documentUrl);
  expect(bodyAt(output, 100)).toBe(bodyAt(input, 100));
  expect(bodyAt(output, 101)).toBe(bodyAt(input, 101));
  expect(bodyAt(output, 30).trim()).toBe('null');
});

test('a reachable element only loses its own ID and Headers in A, not unrelated nested dictionary entries', () => {
  const nested =
    '/Private << /ID (node888) /Headers [(node999)] /IDTree 101 0 R >>';
  const input = incremental(
    [
      [100, '<< /Type /StructTreeRoot /K [102 0 R] /IDTree 103 0 R >>'],
      [101, '<< /Names [(private) 3 0 R] >>'],
      [
        102,
        `<< /Type /StructElem /S /TD /P 100 0 R /K 0 /ID (node123) /A << /O /Table /Headers [(node456)] >> ${nested} >>`,
      ],
      [103, '<< /Names [(node123) 102 0 R] >>'],
      [104, '<< /Type /Catalog /Pages 10 0 R /StructTreeRoot 100 0 R >>'],
    ],
    '/Root 104 0 R /Info 1 0 R',
  );
  const output = stablePdf(input, documentUrl);
  expect.soft(bodyAt(output, 102)).toContain(nested);
  expect.soft(bodyAt(output, 101)).toBe(bodyAt(input, 101));
  expect(bodyAt(output, 102)).not.toContain('/ID (node123)');
  expect(bodyAt(output, 102)).not.toContain('/Headers [(node456)]');
  expect(bodyAt(output, 103).trim()).toBe('null');
  // The old catalog's tree is no longer the selected structure tree.
  expect.soft(bodyAt(output, 12)).toBe(bodyAt(input, 12));
  expect.soft(bodyAt(output, 30)).toBe(bodyAt(input, 30));
});

test('only the last trailer Info is normalized, leaving older metadata untouched', () => {
  const input = incremental(
    [
      [
        100,
        '<< /Title (Authored) /CreationDate (D:20261027065851) /ModDate (D:20261027065851) >>',
      ],
    ],
    '/Root 31 0 R /Info 100 0 R',
  );
  const output = stablePdf(input, documentUrl);
  expect(bodyAt(output, 1)).toBe(bodyAt(input, 1));
  expect(bodyAt(output, 100)).toContain('/Title (Authored)');
  expect(bodyAt(output, 100)).not.toMatch(/\/(CreationDate|ModDate)\b/);
});

test('a final trailer without Info does not authorize editing an earlier trailer Info', () => {
  const input = incremental([[100, '<< /Unused true >>']], '/Root 31 0 R');
  const output = stablePdf(input, documentUrl);
  expect(bodyAt(output, 1)).toBe(bodyAt(input, 1));
});
