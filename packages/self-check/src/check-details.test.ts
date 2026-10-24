import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { type CheckOptions, checkPdf, readPdf } from './index.ts';

const fixtures = new Map<string, { pdf: Uint8Array; gt: GroundTruth }>();
const names = [
  'table-grid',
  'table-merged',
  'table-borders',
  'table-cross-page',
  'table-repeat-header',
  'checkbox',
  'formula',
  'details',
  'math-prefix',
  'marks',
];
const symbolFont = 'NotoSansSymbols2-Regular';
const longText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij';
const cell = (
  row: number,
  col: number,
  text: string,
  bbox: number[],
  checkboxes?: { checked: boolean; text: string; bbox: number[] }[],
) => ({
  row,
  col,
  rowSpan: 1,
  colSpan: 1,
  header: false,
  text,
  bbox,
  ...(checkboxes ? { checkboxes } : {}),
});

// Hand-derived from details.html's CSS, never from the PDF or DOM reader.
const detailsGt = gtSchema.parse({
  schemaVersion: 1,
  source: { templateId: 'details', templateVersion: 1, seed: 'T14', index: 0 },
  pages: Array.from({ length: 2 }, () => ({ width: 595.28, height: 841.89 })),
  blocks: [
    {
      id: 'yes',
      type: 'checkbox',
      page: 1,
      bbox: [54, 54, 414, 90],
      order: 0,
      text: '☑Agree',
      checked: true,
    },
    {
      id: 'no',
      type: 'checkbox',
      page: 1,
      bbox: [54, 90, 414, 126],
      order: 1,
      text: '☐Decline',
      checked: false,
    },
    {
      id: 'choices',
      type: 'table',
      page: 1,
      bbox: [54, 126, 414, 198],
      order: 2,
      text: 'Options☑Yes☐No☑LaterGraphicsNativeDrawn',
      table: {
        rows: 2,
        cols: 2,
        cells: [
          cell(0, 0, 'Options', [54, 126, 174, 162]),
          cell(
            0,
            1,
            '☑Yes☐No☑Later',
            [174, 126, 414, 162],
            [
              { checked: true, text: 'Yes', bbox: [174, 126, 192, 144] },
              { checked: false, text: 'No', bbox: [264, 126, 282, 144] },
              { checked: true, text: 'Later', bbox: [174, 144, 192, 162] },
            ],
          ),
          cell(1, 0, 'Graphics', [54, 162, 174, 198]),
          cell(
            1,
            1,
            'NativeDrawn',
            [174, 162, 414, 198],
            [
              { checked: true, text: 'Native', bbox: [174, 162, 186, 174] },
              { checked: false, text: 'Drawn', bbox: [264, 162, 276, 174] },
            ],
          ),
        ],
      },
    },
    {
      id: 'math',
      type: 'formula',
      page: 1,
      bbox: [54, 198, 414, 234],
      order: 3,
      text: 'x + y',
      latex: 'x+y',
    },
    {
      id: 'known',
      type: 'paragraph',
      page: 2,
      bbox: [54, 54, 414, 90],
      order: 4,
      text: '☑☐',
    },
    {
      id: 'other',
      type: 'paragraph',
      page: 2,
      bbox: [54, 90, 414, 126],
      order: 5,
      text: longText,
    },
    {
      id: 'known-again',
      type: 'paragraph',
      page: 2,
      bbox: [54, 126, 414, 162],
      order: 6,
      text: '☑',
    },
    {
      id: 'other-again',
      type: 'paragraph',
      page: 2,
      bbox: [54, 162, 414, 198],
      order: 7,
      text: 'TAIL',
    },
  ],
});

const marks = ['☑', '☒', '✓', '✔', '✅', '☐', '□', '☐☑'];
const marksGt = gtSchema.parse({
  schemaVersion: 1,
  source: { templateId: 'marks', templateVersion: 1, seed: 'T14', index: 0 },
  pages: [{ width: 595.28, height: 841.89 }],
  blocks: marks.map((text, i) => ({
    id: `mark-${i}`,
    type: 'checkbox',
    page: 1,
    bbox: [54, 54 + i * 24, 354, 78 + i * 24],
    order: i,
    text,
    checked: i < 5,
  })),
});
const mathGt = gtSchema.parse({
  schemaVersion: 1,
  source: {
    templateId: 'math-prefix',
    templateVersion: 1,
    seed: 'T14',
    index: 0,
  },
  pages: [{ width: 595.28, height: 841.89 }],
  blocks: [
    {
      id: 'math',
      type: 'formula',
      page: 1,
      bbox: [54, 54, 414, 90],
      order: 0,
      text: 'x + y',
      latex: 'x+y',
    },
  ],
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const name of names) {
      const base = new URL(
        `${['details', 'math-prefix', 'marks'].includes(name) ? '..' : '../../ground-truth'}/fixtures/${name}`,
        import.meta.url,
      );
      const gt =
        name === 'marks'
          ? marksGt
          : name === 'math-prefix'
            ? mathGt
            : name === 'details'
              ? detailsGt
              : gtSchema.parse(
                  JSON.parse(
                    await readFile(`${fileURLToPath(base)}.gt.json`, 'utf8'),
                  ),
                );
      const page = await browser.newPage();
      try {
        await page.goto(`${base.href}.html`);
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(`window.__pagedDone = false; window.PagedConfig = {
          auto: true, before: () => window.registerFixtureHandlers?.(),
          after: () => { window.__pagedDone = true; }
        };`);
        await page.addScriptTag({
          path: fileURLToPath(
            new URL(
              '../dist/paged.polyfill.js',
              import.meta.resolve('pagedjs'),
            ),
          ),
        });
        await page.waitForFunction('window.__pagedDone === true');
        await page.evaluate('document.fonts.ready');
        expect(await page.locator('.pagedjs_page').count()).toBe(
          gt.pages.length,
        );
        fixtures.set(name, {
          pdf: await page.pdf({
            preferCSSPageSize: true,
            printBackground: true,
          }),
          gt,
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

function fixture(name = 'details') {
  const value = fixtures.get(name);
  if (!value) throw new Error(`fixture not printed: ${name}`);
  return value;
}
function mutate(name: string, change: (gt: GroundTruth) => void) {
  const gt = structuredClone(fixture(name).gt);
  change(gt);
  return gtSchema.parse(gt);
}
function table(gt: GroundTruth) {
  const block = gt.blocks.find(block => block.type === 'table');
  if (block?.type !== 'table') throw new Error('missing table');
  return block;
}
async function differences(
  name: string,
  gt: GroundTruth,
  options?: CheckOptions,
) {
  const report = await checkPdf(fixture(name).pdf, gt, options);
  expect(report.ok).toBe(report.differences.length === 0);
  return report.differences.map(({ message, ...difference }) => {
    expect(message.length).toBeGreaterThan(0);
    return difference;
  });
}
const cellDifference = (
  row: number,
  col: number,
  expected: string,
  actual: string,
  blockId = 'grid',
) => ({ kind: 'cell_text', page: 1, blockId, row, col, expected, actual });

// Acceptance first: actual Paged.js PDFs against independent fixture oracles.
test.each(names.filter(name => !['math-prefix', 'table-grid'].includes(name)))(
  'correct %s passes table, checkbox and formula checks',
  async name => {
    expect(await checkPdf(fixture(name).pdf, fixture(name).gt)).toEqual({
      ok: true,
      differences: [],
    });
  },
);

test.each([false, true])(
  'wrong cell is checked even when whole table text matches: %s',
  async keepWholeText => {
    const gt = mutate('table-grid', gt => {
      required(table(gt).table.cells[3]).text = 'Coffee';
      if (!keepWholeText)
        table(gt).text = table(gt).text.replace('Tea\nLeaf', 'Coffee');
    });
    expect(await differences('table-grid', gt)).toEqual([
      cellDifference(1, 0, 'Coffee', 'TeaLeaf'),
    ]);
  },
);

test('a row present only in gt reports each nonempty missing cell without a block text cascade', async () => {
  const gt = mutate('table-grid', gt => {
    const block = table(gt);
    block.bbox[3] = 174;
    block.table.rows++;
    block.table.cells.push(
      cell(
        4,
        0,
        'Lost',
        [54, 150, 126, 174],
      ) as (typeof block.table.cells)[number],
      cell(
        4,
        1,
        '7',
        [126, 150, 222, 174],
      ) as (typeof block.table.cells)[number],
      cell(
        4,
        2,
        '',
        [222, 150, 294, 174],
      ) as (typeof block.table.cells)[number],
    );
    block.text += '\nLost\t7\t';
  });
  expect(await differences('table-grid', gt)).toEqual([
    cellDifference(4, 0, 'Lost', ''),
    cellDifference(4, 1, '7', ''),
  ]);
});

test('cell ownership uses the smallest containing cell and diagnostics follow gt cells order', async () => {
  const gt = mutate('table-grid', gt => {
    const cells = table(gt).table.cells;
    required(cells[0]).bbox = [...table(gt).bbox]; // Encloses all other cells.
    required(cells[0]).text = 'Wrong header';
    required(cells[3]).text = 'Wrong tea';
    [cells[0], cells[3]] = [required(cells[3]), required(cells[0])];
  });
  expect(await differences('table-grid', gt)).toEqual([
    cellDifference(1, 0, 'Wrong tea', 'TeaLeaf'),
    cellDifference(0, 0, 'Wrong header', 'Item'),
  ]);
});

test('table text outside all cells still reports a block text difference', async () => {
  const gt = mutate('table-grid', gt => {
    table(gt).text += 'Invented';
  });
  expect(await differences('table-grid', gt)).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'grid',
      expected: table(gt).text,
      actual: 'ItemQtyNoteTeaLeaf2Total0End3Done',
    },
  ]);
});

test('cell comparison normalises whitespace, compatibility forms and case', async () => {
  const gt = mutate('table-grid', gt => {
    required(table(gt).table.cells[3]).text = ' ＴＥＡ\t\nＬＥＡＦ ';
  });
  expect(await differences('table-grid', gt)).toEqual([]);
});

test('table relocation wins over misleading empty-cell differences', async () => {
  const gt = mutate('table-grid', gt => {
    const block = table(gt);
    block.bbox = [54, 300, 294, 396];
    for (const cell of block.table.cells) {
      cell.bbox[1] += 246;
      cell.bbox[3] += 246;
    }
  });
  const result = await differences('table-grid', gt);
  expect(result).toEqual([
    {
      kind: 'bbox',
      page: 1,
      blockId: 'grid',
      bbox: [54, 300, 294, 396],
      textBox: expect.any(Array),
    },
  ]);
});

test.each([
  ['yes', false, true],
  ['no', true, false],
] as const)(
  'flipping only checked for block %s reports exactly one checkbox difference',
  async (id, expected, actual) => {
    const gt = mutate('details', gt => {
      const block = gt.blocks.find(block => block.id === id);
      if (block?.type === 'checkbox') block.checked = expected;
    });
    expect(await differences('details', gt)).toEqual([
      { kind: 'checkbox', page: 1, blockId: id, expected, actual },
    ]);
  },
);

test('cell marks use their own boxes and report checkboxes in index order', async () => {
  const gt = mutate('details', gt => {
    for (const checkbox of required(
      required(table(gt).table.cells[1]).checkboxes,
    ))
      checkbox.checked = !checkbox.checked;
  });
  expect(await differences('details', gt)).toEqual(
    [true, false, true].map((actual, checkbox) => ({
      kind: 'checkbox',
      page: 1,
      blockId: 'choices',
      row: 0,
      col: 1,
      checkbox,
      expected: !actual,
      actual,
    })),
  );
});

test('checkbox labels stop at the next mark and continue on the next line', async () => {
  const gt = mutate('details', gt => {
    required(required(table(gt).table.cells[1]).checkboxes).forEach(
      checkbox => {
        checkbox.text = 'Wrong';
      },
    );
  });
  expect(await differences('details', gt)).toEqual(
    ['Yes', 'No', 'Later'].map((actual, checkbox) => ({
      kind: 'checkbox_label',
      page: 1,
      blockId: 'choices',
      row: 0,
      col: 1,
      checkbox,
      expected: 'Wrong',
      actual,
    })),
  );
});

test('cell text differences precede checkbox state differences and suppress label comparisons', async () => {
  const gt = mutate('details', gt => {
    const cell = required(table(gt).table.cells[1]);
    cell.text = 'Wrong cell';
    required(required(cell.checkboxes)[0]).checked = false;
    required(required(cell.checkboxes)[0]).text = 'Wrong label';
  });
  expect(await differences('details', gt)).toEqual([
    cellDifference(0, 1, 'Wrong cell', '☑Yes☐No☑Later', 'choices'),
    {
      kind: 'checkbox',
      page: 1,
      blockId: 'choices',
      row: 0,
      col: 1,
      checkbox: 0,
      expected: false,
      actual: true,
    },
  ]);
});

test('native inputs and CSS boxes without text glyphs do not invent printed checkbox states', async () => {
  const gt = mutate('details', gt => {
    for (const checkbox of required(
      required(table(gt).table.cells[3]).checkboxes,
    ))
      checkbox.checked = !checkbox.checked;
  });
  expect(await differences('details', gt)).toEqual([]);
});

test('a painted transparent MathML prefix does not invalidate a formula suffix', async () => {
  const { pdf, gt } = fixture('math-prefix');
  const { pages } = await readPdf(pdf);
  // Precondition catches a clipped or reordered copy, not missing checker behavior.
  expect(
    required(pages[0])
      .items.map(item => item.text)
      .join(''),
  ).toBe('𝑥+𝑦x + y');
  expect(await differences('math-prefix', gt)).toEqual([]);
});

test('formula suffix tolerance cannot hide wrong visible text', async () => {
  const gt = mutate('math-prefix', gt => {
    required(gt.blocks[0]).text = 'wrong';
  });
  expect(await differences('math-prefix', gt)).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'math',
      expected: 'wrong',
      actual: '𝑥+𝑦x + y',
    },
  ]);
});

test('font checks group each page/font in first appearance order after unmarked runs and truncate at 40 characters', async () => {
  // Derive only the setup's allowlist; expected text comes from the HTML.
  const { pdf } = fixture();
  const { pages } = await readPdf(pdf);
  const items = required(pages[1]).items;
  expect(items.map(item => item.text).join('')).toBe(`☑☐${longText}☑TAIL`);
  expect(
    items
      .filter(item => item.text.includes('☑'))
      .every(item => item.font === symbolFont),
  ).toBe(true);
  const otherFonts = [
    ...new Set(
      items.filter(item => /[A-Z]/.test(item.text)).map(item => item.font),
    ),
  ];
  expect(otherFonts).toHaveLength(1);
  expect(otherFonts[0]).not.toBe(symbolFont);
  const gt = mutate('details', gt => {
    gt.blocks = gt.blocks.filter(block => block.id !== 'other-again');
  });
  const allowedOnFirstPage = [
    ...new Set(required(pages[0]).items.map(item => item.font)),
  ];
  const result = await differences('details', gt, {
    fonts: allowedOnFirstPage.filter(
      font => font !== symbolFont && font !== otherFonts[0],
    ),
  });
  expect(result).toEqual([
    { kind: 'font', page: 1, font: symbolFont, text: '☑☐☑☐☑' },
    {
      kind: 'unmarked_text',
      page: 2,
      text: 'TAIL',
      textBox: expect.any(Array),
    },
    { kind: 'font', page: 2, font: symbolFont, text: '☑☐☑' },
    {
      kind: 'font',
      page: 2,
      font: expect.any(String),
      text: longText.slice(0, 40),
    },
  ]);
  // Same known font must also be reported separately on page one.
  expect(
    result
      .filter(
        difference =>
          difference.kind === 'font' && difference.font === symbolFont,
      )
      .map(difference => ('page' in difference ? difference.page : undefined)),
  ).toEqual([1, 2]);
  const fallback = required(result[3]);
  expect(fallback.kind).toBe('font');
  if (fallback.kind === 'font') expect(fallback.font).not.toBe(symbolFont);
});

test('allowing every printed PostScript name suppresses font differences', async () => {
  const { pdf, gt } = fixture();
  const { pages } = await readPdf(pdf);
  const fonts = [
    ...new Set(pages.flatMap(page => page.items.map(item => item.font))),
  ];
  expect(await differences('details', gt, { fonts })).toEqual([]);
});

test.each(marks.map((mark, index) => ({ mark, index })))(
  'mark $mark uses its first glyph for the printed state',
  async ({ index }) => {
    const gt = mutate('marks', gt => {
      const block = required(gt.blocks[index]);
      if (block.type === 'checkbox') block.checked = index >= 5;
    });
    expect(await differences('marks', gt)).toEqual([
      {
        kind: 'checkbox',
        page: 1,
        blockId: `mark-${index}`,
        expected: index >= 5,
        actual: index < 5,
      },
    ]);
  },
);

test('checkbox label comparison tolerates whitespace and compatibility forms', async () => {
  const gt = mutate('details', gt => {
    required(required(required(table(gt).table.cells[1]).checkboxes)[0]).text =
      ' ＹＥＳ\t\n ';
  });
  expect(await differences('details', gt)).toEqual([]);
});

test('native checkbox blocks without mark glyphs skip state comparison', async () => {
  const gt = mutate('checkbox', gt => {
    for (const block of gt.blocks)
      if (block.type === 'checkbox' && !block.id.startsWith('symbol'))
        block.checked = !block.checked;
  });
  expect(await differences('checkbox', gt)).toEqual([]);
});
