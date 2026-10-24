// Acceptance run for T14: prints documents through a running print Worker
// (which reads gt.json on the same tab), then checks each PDF against its
// gt.json and against deliberately wrong copies of it. Not a unit test: it
// needs a Worker with a browser (local `wrangler dev`, or the deployed one).
//
//   PRINT_URL=http://127.0.0.1:8788 PRINT_TOKEN=… node acceptance/run.ts [outDir]
//
// Writes each PDF, gt.json, wrong gt.json and report to outDir (default
// .wrangler/self-check-acceptance) and a summary.json; exits 1 on a failure.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { checkPdf, type Difference } from '../src/index.ts';

const base = process.env.PRINT_URL ?? 'http://127.0.0.1:8788';
const token = process.env.PRINT_TOKEN;
if (!token) throw new Error('set PRINT_TOKEN');
const outDir =
  process.argv[2] ??
  join(import.meta.dirname, '../../../.wrangler/self-check-acceptance');
await mkdir(outDir, { recursive: true });

/** A deliberately wrong gt.json and the differences it must give. */
interface Mutation {
  name: string;
  mutate: (gt: GroundTruth) => void;
  /**
   * The differences it must give, without `message`, from the wrong and the
   * correct gt.json; only the keys given are compared (boxes vary by Chrome).
   */
  expected: (wrong: GroundTruth, correct: GroundTruth) => Partial<Difference>[];
}

const blockOf = (gt: GroundTruth, id: string) => {
  const block = gt.blocks.find(block => block.id === id);
  if (!block) throw new Error(`no block ${id}`);
  return block;
};
const tableOf = (gt: GroundTruth) => {
  const table = blockOf(gt, 'choices');
  if (table.type !== 'table') throw new Error('choices is not a table');
  return table;
};
const renumber = (gt: GroundTruth) => {
  [...gt.blocks]
    .sort((a, b) => a.order - b.order)
    .forEach((block, order) => {
      block.order = order;
    });
};

const mutations: Mutation[] = [
  {
    name: 'wrong-text',
    mutate: gt => {
      blockOf(gt, 'summary').text =
        '十月二十三日下午三時，三樓倉庫因漏水造成部分紙箱受潮。';
    },
    expected: gt => [
      {
        kind: 'text',
        page: 1,
        blockId: 'summary',
        expected: blockOf(gt, 'summary').text,
      },
    ],
  },
  {
    name: 'box-shifted',
    mutate: gt => {
      const box = blockOf(gt, 'title').bbox;
      blockOf(gt, 'title').bbox = [box[0] + 40, box[1], box[2] + 40, box[3]];
    },
    expected: () => [{ kind: 'bbox', page: 1, blockId: 'title' }],
  },
  {
    name: 'box-moved-down',
    mutate: gt => {
      const box = blockOf(gt, 'followup').bbox;
      blockOf(gt, 'followup').bbox = [
        box[0],
        box[1] + 200,
        box[2],
        box[3] + 200,
      ];
    },
    expected: () => [{ kind: 'bbox', page: 2, blockId: 'followup' }],
  },
  {
    name: 'wrong-page',
    mutate: gt => {
      blockOf(gt, 'followup').page = 1;
    },
    expected: () => [
      { kind: 'page', page: 1, blockId: 'followup', actualPage: 2 },
    ],
  },
  {
    name: 'missing-block',
    mutate: gt => {
      gt.blocks = gt.blocks.filter(block => block.id !== 'summary');
      renumber(gt);
    },
    expected: (_, correct) => [
      {
        kind: 'unmarked_text',
        page: 1,
        text: blockOf(correct, 'summary').text,
      },
    ],
  },
  {
    name: 'extra-block',
    mutate: gt => {
      gt.blocks.push({
        id: 'ghost',
        type: 'paragraph',
        page: 2,
        bbox: [60, 600, 400, 620],
        order: gt.blocks.length,
        text: '本段文字並未印出',
      });
    },
    expected: () => [
      {
        kind: 'text',
        page: 2,
        blockId: 'ghost',
        expected: '本段文字並未印出',
        actual: '',
      },
    ],
  },
  {
    name: 'wrong-order',
    mutate: gt => {
      const title = blockOf(gt, 'title');
      const followup = blockOf(gt, 'followup');
      [title.order, followup.order] = [followup.order, title.order];
    },
    expected: gt => [
      {
        kind: 'order',
        page: 1,
        blockId: 'title',
        order: blockOf(gt, 'title').order,
      },
      {
        kind: 'order',
        page: 2,
        blockId: 'followup',
        order: blockOf(gt, 'followup').order,
      },
    ],
  },
  {
    name: 'wrong-page-count',
    mutate: gt => {
      gt.pages.push({ width: 595.28, height: 841.89 });
    },
    expected: () => [{ kind: 'page_count', expected: 3, actual: 2 }],
  },
  {
    name: 'wrong-cell-text',
    mutate: gt => {
      const cell = tableOf(gt).table.cells.find(
        cell => cell.text === '事故類型',
      );
      if (cell) cell.text = '事故原因';
    },
    expected: () => [
      {
        kind: 'cell_text',
        page: 1,
        blockId: 'choices',
        row: 2,
        col: 0,
        expected: '事故原因',
        actual: '事故類型',
      },
    ],
  },
  {
    name: 'lost-row',
    // What Paged.js's lost row looks like from gt.json's side: the DOM has a
    // row the PDF lacks.
    mutate: gt => {
      const table = tableOf(gt);
      const last = table.table.cells.filter(
        cell => cell.row === table.table.rows - 1,
      );
      const height = (last[0]?.bbox[3] ?? 0) - (last[0]?.bbox[1] ?? 0);
      for (const cell of last) {
        table.table.cells.push({
          ...structuredClone(cell),
          row: table.table.rows,
          text: cell.col === 0 ? '受傷人數' : '0',
          bbox: [
            cell.bbox[0],
            cell.bbox[3],
            cell.bbox[2],
            cell.bbox[3] + height,
          ],
          checkboxes: undefined,
        });
      }
      table.table.rows += 1;
      table.bbox[3] += height;
      table.text += '\n受傷人數\t0';
    },
    expected: () => [
      {
        kind: 'cell_text',
        page: 1,
        blockId: 'choices',
        row: 3,
        col: 0,
        expected: '受傷人數',
        actual: '',
      },
      {
        kind: 'cell_text',
        page: 1,
        blockId: 'choices',
        row: 3,
        col: 1,
        expected: '0',
        actual: '',
      },
    ],
  },
  {
    name: 'wrong-checkbox',
    mutate: gt => {
      const block = blockOf(gt, 'reported');
      if (block.type === 'checkbox') block.checked = false;
    },
    expected: () => [
      {
        kind: 'checkbox',
        page: 1,
        blockId: 'reported',
        expected: false,
        actual: true,
      },
    ],
  },
  {
    name: 'wrong-cell-checkbox',
    mutate: gt => {
      const box = tableOf(gt).table.cells.find(
        cell => cell.row === 2 && cell.col === 1,
      )?.checkboxes?.[1];
      if (box) box.checked = false;
    },
    expected: () => [
      {
        kind: 'checkbox',
        page: 1,
        blockId: 'choices',
        row: 2,
        col: 1,
        checkbox: 1,
        expected: false,
        actual: true,
      },
    ],
  },
  {
    name: 'wrong-checkbox-label',
    mutate: gt => {
      const box = tableOf(gt).table.cells.find(
        cell => cell.row === 1 && cell.col === 1,
      )?.checkboxes?.[0];
      if (box) box.text = '否';
    },
    expected: () => [
      {
        kind: 'checkbox_label',
        page: 1,
        blockId: 'choices',
        row: 1,
        col: 1,
        checkbox: 0,
        expected: '否',
        actual: '是',
      },
    ],
  },
  {
    name: 'wrong-page-size',
    mutate: gt => {
      for (const page of gt.pages) page.height = 792;
    },
    expected: () => [
      { kind: 'page_size', page: 1, expected: [595.28, 792] },
      { kind: 'page_size', page: 2, expected: [595.28, 792] },
    ],
  },
];

async function print(file: string) {
  const html = await readFile(join(import.meta.dirname, file), 'utf8');
  const response = await fetch(new URL('/print', base), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 't14-acceptance',
        templateVersion: 1,
        seed: 'T14',
        index: 0,
      },
    }),
  });
  if (!response.ok)
    throw new Error(
      `print ${file}: ${response.status} ${await response.text()}`,
    );
  const body = (await response.json()) as { pdf: string; gt: unknown };
  return {
    pdf: new Uint8Array(Buffer.from(body.pdf, 'base64')),
    gt: gtSchema.parse(body.gt),
  };
}

const strip = (differences: Difference[]) =>
  differences.map(({ message: _message, ...rest }) => rest);
// Only the keys the expectation names; boxes and measured sizes vary by Chrome.
const matches = (
  actual: Record<string, unknown>[],
  expected: Partial<Difference>[],
) =>
  actual.length === expected.length &&
  expected.every((want, i) =>
    Object.entries(want).every(([key, value]) => {
      const got = actual[i]?.[key];
      return key === 'text' || key === 'actual'
        ? String(got).replace(/\s/g, '') === String(value).replace(/\s/g, '')
        : isDeepStrictEqual(got, value);
    }),
  );

// The platform fonts' PostScript names (apps/print/public/fonts).
const platformFonts = [
  'LXGWWenKaiTC-Regular',
  'NotoSansSymbols2-Regular',
  'NotoSansTC-Bold',
  'NotoSansTC-Regular',
  'NotoSerifTC-Bold',
  'NotoSerifTC-Regular',
];
const results: { name: string; pass: boolean; differences: Difference[] }[] =
  [];
const check = async (
  name: string,
  pdf: Uint8Array,
  gt: GroundTruth,
  expected: Partial<Difference>[],
  fonts: readonly string[] = platformFonts,
) => {
  await writeFile(
    join(outDir, `${name}.gt.json`),
    `${JSON.stringify(gt, null, 2)}\n`,
  );
  const report = await checkPdf(pdf, gt, { fonts });
  await writeFile(
    join(outDir, `${name}.report.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const pass =
    report.ok === (expected.length === 0) &&
    matches(strip(report.differences), expected);
  results.push({ name, pass, differences: report.differences });
};

const { pdf, gt } = await print('fixture.html');
await writeFile(join(outDir, 'fixture.pdf'), pdf);
await check('correct', pdf, gt, []);
for (const mutation of mutations) {
  const wrong = structuredClone(gt);
  mutation.mutate(wrong);
  const parsed = gtSchema.parse(wrong);
  await check(mutation.name, pdf, parsed, mutation.expected(parsed, gt));
}
// The pack's font list without the symbol font: every ☑/☐ is reported.
await check(
  'font-not-in-pack',
  pdf,
  gt,
  [{ kind: 'font', page: 1, font: 'NotoSansSymbols2-Regular', text: '☑☑☐☐☑' }],
  platformFonts.filter(font => font !== 'NotoSansSymbols2-Regular'),
);

// A glyph no platform font has falls back to a system font.
const fallback = await print('fallback.html');
await writeFile(join(outDir, 'fallback.pdf'), fallback.pdf);
await check('font-fallback', fallback.pdf, fallback.gt, [
  { kind: 'font', page: 1, text: '㵾' },
]);

// T07's portrait document: its page counter is CSS-generated content
// (`@bottom-center { content: counter(page) }`), which gt.json can't hold.
const portrait = await print('../../../apps/print/acceptance/portrait.html');
await writeFile(join(outDir, 't07-portrait.pdf'), portrait.pdf);
await check(
  't07-portrait',
  portrait.pdf,
  portrait.gt,
  [1, 2, 3].map(page => ({
    kind: 'unmarked_text',
    page,
    text: `第${page}頁，共3頁`,
  })),
);

await writeFile(
  join(outDir, 'summary.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}`);
  for (const difference of result.differences) {
    console.log(`     ${difference.kind}: ${difference.message}`);
  }
}
process.exitCode = results.every(result => result.pass) ? 0 : 1;
