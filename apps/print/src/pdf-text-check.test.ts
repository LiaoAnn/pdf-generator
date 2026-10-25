import { type ExpectedBlock, readPdf } from '@pdf-generator/self-check';
import { extractText } from 'unpdf';
import { beforeAll, expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

// A genuine, tiny two-page PDF, not fake "%PDF" bytes. A ToUnicode map
// deliberately exposes A as fullwidth Ａ so skipping NFKC causes a false alarm.
// Building it here avoids Chromium launches for every missing-text case.
function fixturePdf(
  firstPage = 'BT /F1 12 Tf 50 750 Td (A B C TOKEN TOKEN) Tj ET',
) {
  const stream = (text: string) =>
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /FixtureUnicode def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
95 beginbfchar
${Array.from({ length: 95 }, (_, i) => {
  const code = i + 32;
  return `<${code.toString(16)}> <${(code === 65 ? 0xff21 : code).toString(16).padStart(4, '0')}>`;
}).join('\n')}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[6, 7].map(
      content => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]
        /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`,
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 8 0 R >>',
    stream(firstPage),
    stream('BT /F1 12 Tf 50 750 Td (SECOND) Tj ET'),
    stream(cmap),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

beforeAll(async () => {
  // If this fails it is a fixture/setup error, not evidence of RED behavior.
  const { text } = await extractText(fixturePdf(), { mergePages: false });
  expect(text.map(value => value.trim())).toEqual([
    'Ａ B C TOKEN TOKEN',
    'SECOND',
  ]);
});

const request = {
  html: '<html><body><p data-gt="text">ABC</p></body></html>',
  page: { size: 'A4', orientation: 'portrait' },
} as const;

// Baseline 92 pt from the top; the 12 pt text anchor is at y = 87.8.
const paragraphBox = { x0: 45, y0: 75, x1: 300, y1: 100 };
const formulaBox = { x0: 345, y0: 175, x1: 450, y1: 200 };
const block = (texts: string[], box = paragraphBox): ExpectedBlock => ({
  texts: texts.map(text => ({ text, boxes: [box] })),
});

function fakeBrowser(expectedText?: ExpectedBlock[][], bytes = fixturePdf()) {
  const calls: string[] = [];
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      pageCount: 2,
      unloadedFaces: [],
      fragmentedRows: [],
      ...(expectedText === undefined ? {} : { expectedText }),
    })),
    pdf: vi.fn(async () => {
      calls.push('pdf');
      return bytes;
    }),
    close: vi.fn(async () => {
      calls.push('close');
    }),
  };
  return {
    browser: fakeBrowserContext(page).browser,
    page,
    calls,
  };
}

test.each([
  {
    name: 'a DOM-visible row absent from the PDF',
    expected: [[block(['LOST_ROW'])], []],
    detail: 'page 1: LOST_ROW',
  },
  {
    name: 'a third duplicate backed by only two PDF occurrences',
    expected: [[block(['TOKEN', 'TOKEN', 'TOKEN'])], []],
    detail: 'page 1: TOKEN',
  },
  {
    name: 'text printed on the wrong page',
    expected: [[block(['SECOND'])], []],
    detail: 'page 1: SECOND',
  },
  {
    name: 'missing text on page two with a bounded diagnostic',
    expected: [[], [block(['X'.repeat(65)])]],
    detail: `page 2: ${'X'.repeat(40)}`,
  },
  {
    name: 'a letter printed only in the neighbouring paragraph box',
    expected: [[block(['C'], formulaBox)], []],
    detail: 'page 1: C',
  },
])('rejects $name and still closes the tab', async ({ expected, detail }) => {
  // Regression: DOM checks, global-page searches and Set membership all miss
  // different forms of lost text; failed renders must still release their tab.
  const fake = fakeBrowser(expected);
  const inspect = vi.fn(async () => {
    fake.calls.push('inspect');
    return 'boxes';
  });
  const outcome = await renderPdf(fake.browser, request, {
    store: { put: async () => {}, delete: async () => {} },
    assetOrigin: 'https://print-assets.example.test',
    inspect,
  }).then(
    () => 'render unexpectedly succeeded',
    (error: unknown) => error,
  );
  expect.soft(outcome).toBeInstanceOf(RenderError);
  expect
    .soft(outcome)
    .toMatchObject({ code: 'text_missing', details: [detail] });
  expect(fake.calls).toContain('pdf');
  expect(fake.calls.at(-1)).toBe('close');
  expect(fake.page.evaluate).toHaveBeenCalled();
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test('PDF normalization tolerates compatibility glyphs and whitespace while consuming repeated text once per occurrence', async () => {
  const fake = fakeBrowser([
    [block(['abc', 'TOKEN', 'TOKEN'])],
    [block(['SECOND'])],
  ]);
  const result = await renderPdf(fake.browser, request, {
    store: { put: async () => {}, delete: async () => {} },
    assetOrigin: 'https://print-assets.example.test',
  });
  expect(result.pdf).toEqual(fixturePdf());
  expect(result.pageCount).toBe(2);
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test.each([
  { name: 'absent', expectedText: undefined },
  { name: 'empty page list', expectedText: [] },
  { name: 'pages with no blocks', expectedText: [[], []] },
])(
  '$name text expectations still allow a valid PDF with matching page count',
  async ({ expectedText }) => {
    const bytes = fixturePdf();
    const fake = fakeBrowser(expectedText, bytes);
    await expect(
      renderPdf(fake.browser, request, {
        store: { put: async () => {}, delete: async () => {} },
        assetOrigin: 'https://print-assets.example.test',
      }),
    ).resolves.toMatchObject({ pdf: bytes });
    expect(fake.page.close).toHaveBeenCalledTimes(1);
  },
);

// Stream order deliberately differs from expectation order: page-wide greedy
// consumption steals x/y/r out of the prose before reaching the formula.
test.each(['formula first', 'paragraph first'] as const)(
  '%s expectations keep later formula glyphs from consuming paragraph letters',
  async order => {
    const bytes = fixturePdf(
      'BT /F1 12 Tf 50 750 Td (Let x be any real number) Tj ET\n' +
        'BT /F1 12 Tf 350 650 Td (y) Tj 25 0 Td (x) Tj 25 0 Td (r) Tj ET',
    );
    const { pages } = await readPdf(bytes);
    expect(pages[0]?.items.map(item => item.text)).toEqual([
      'Let x be any real number',
      'y',
      'x',
      'r',
    ]);
    const paragraph = block(['Let x be any real number']);
    const formula = block(['y', 'x', 'r'], formulaBox);
    const expected =
      order === 'formula first' ? [formula, paragraph] : [paragraph, formula];
    const fake = fakeBrowser([expected, []], bytes);
    const result = await renderPdf(fake.browser, request, {
      store: { put: async () => {}, delete: async () => {} },
      assetOrigin: 'https://print-assets.example.test',
    });
    expect(result.pdf).toEqual(bytes);
    expect(fake.page.close).toHaveBeenCalledTimes(1);
  },
);

test('within a block a leading expected letter does not steal its occurrence from a longer word printed first', async () => {
  const bytes = fixturePdf(
    'BT /F1 12 Tf 50 750 Td (the radius) Tj 100 0 Td (r) Tj ET',
  );
  const { pages } = await readPdf(bytes);
  expect(pages[0]?.items.map(item => item.text)).toEqual(['the radius', 'r']);
  const fake = fakeBrowser([[block(['r', 'the radius'])], []], bytes);
  await expect(
    renderPdf(fake.browser, request, {
      store: { put: async () => {}, delete: async () => {} },
      assetOrigin: 'https://print-assets.example.test',
    }),
  ).resolves.toMatchObject({ pdf: bytes });
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});
