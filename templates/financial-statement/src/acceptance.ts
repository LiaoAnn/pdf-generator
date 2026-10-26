// T24 acceptance on a running stack: zips pack/, uploads it, prints a batch
// and checks it. Passes when every fixture's self-check passes, its pages are
// landscape, every page has the running header and footer in gt.json, every
// fragment of the split statement table starts with the same three header
// rows with the first page's column x ranges, and the table rows in gt.json
// are the ones its data.json asks for.
//   pnpm --filter @pdf-generator/financial-statement acceptance \
//     --url https://app-<wt>.pdf-generator.liaoann.net [--count 10] [--seed t24]
// Signs in with the local Access stand-in's service token (vite dev only).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { GroundTruth } from '@pdf-generator/contract';
import { unzipSync, zipSync } from 'fflate';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    count: { type: 'string', default: '10' },
    seed: { type: 'string', default: 't24-acceptance' },
  },
});
if (values.url === undefined) {
  console.error('usage: acceptance --url <app url> [--count n] [--seed s]');
  process.exit(2);
}
const base = values.url.replace(/\/$/, '');
const headers = {
  'CF-Access-Client-Id': 'local-dev.access',
  'CF-Access-Client-Secret': 'local-dev-secret',
};

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

function zipPack(): Uint8Array {
  const directory = fileURLToPath(new URL('../pack/', import.meta.url));
  const files = Object.fromEntries(
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
  return zipSync(files);
}

type Amounts = {
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  year: number;
  prior: number;
  ratio: number;
};
type Shares = Amounts & { share: number; priorShare: number };
type Statement = {
  company: string;
  businessId: string;
  signers: {
    chairman: string;
    manager: string;
    accountant: string;
    preparer: string;
  };
  regions: Record<
    string,
    {
      name: string;
      customers: (Shares & { name: string; businessId: string })[];
      subtotal: Shares;
    }
  >;
  total: Amounts;
};

const grouped = (value: number) => value.toLocaleString('en-US');
const percent = (value: number) => value.toFixed(2);
const squash = (text: string) => text.replace(/\s+/g, '');

/** Every printed header cell as `row,col,rowSpan,colSpan:text`. */
const header = [
  [0, 0, 3, 1, '客戶名稱'],
  [0, 1, 3, 1, '統一編號'],
  [0, 2, 1, 6, '本年度'],
  [0, 8, 2, 2, '上年度'],
  [0, 10, 2, 1, '比較'],
  [1, 2, 1, 2, '上半年'],
  [1, 4, 1, 2, '下半年'],
  [1, 6, 1, 2, '全年'],
  [2, 2, 1, 1, '第一季'],
  [2, 3, 1, 1, '第二季'],
  [2, 4, 1, 1, '第三季'],
  [2, 5, 1, 1, '第四季'],
  [2, 6, 1, 1, '金額'],
  [2, 7, 1, 1, '占比（%）'],
  [2, 8, 1, 1, '金額'],
  [2, 9, 1, 1, '占比（%）'],
  [2, 10, 1, 1, '本年/上年（%）'],
].map(([row, col, rowSpan, colSpan, text]) =>
  [row, col, rowSpan, colSpan].join(',').concat(':', String(text)),
);

const amounts = (row: Amounts, share: string, priorShare: string) => [
  grouped(row.q1),
  grouped(row.q2),
  grouped(row.q3),
  grouped(row.q4),
  grouped(row.year),
  share,
  grouped(row.prior),
  priorShare,
  percent(row.ratio),
];

/** The statement's body rows the data asks for, cell texts in column order. */
function expectedRows(record: Statement): string[][] {
  return [
    ...Object.values(record.regions).flatMap(region => [
      [region.name],
      ...region.customers.map(customer => [
        customer.name,
        customer.businessId,
        ...amounts(
          customer,
          percent(customer.share),
          percent(customer.priorShare),
        ),
      ]),
      [
        `${region.name}小計`,
        ...amounts(
          region.subtotal,
          percent(region.subtotal.share),
          percent(region.subtotal.priorShare),
        ),
      ],
    ]),
    ['總計', ...amounts(record.total, '100.00', '100.00')],
  ].map(row => row.map(squash));
}

type Block = GroundTruth['blocks'][number];
type TableBlock = Extract<Block, { type: 'table' }>;

/** A table block and every block that continues it, in print order. */
function fragments(first: TableBlock, tables: TableBlock[]): TableBlock[] {
  const parts = [first];
  for (;;) {
    const last = parts.at(-1);
    const next = tables.find(table => table.continues === last?.id);
    if (next === undefined) return parts;
    parts.push(next);
  }
}

/** Body rows of a fragment, cell texts in column order. */
function bodyRows(part: TableBlock): string[][] {
  const rows = new Map<number, [number, string][]>();
  for (const cell of part.table.cells) {
    if (cell.header) continue;
    rows.set(cell.row, [
      ...(rows.get(cell.row) ?? []),
      [cell.col, squash(cell.text)],
    ]);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, cells]) =>
      cells.sort(([a], [b]) => a - b).map(([, text]) => text),
    );
}

/** Each column's x range in a fragment, from its first one-column cell. */
function columnRanges(part: TableBlock): Map<number, [number, number]> {
  const ranges = new Map<number, [number, number]>();
  for (const cell of part.table.cells) {
    if (cell.colSpan === 1 && !ranges.has(cell.col)) {
      ranges.set(cell.col, [cell.bbox[0], cell.bbox[2]]);
    }
  }
  return ranges;
}

/** What is wrong with one fixture's gt.json against its data.json. */
function compare(gt: GroundTruth, record: Statement): string[] {
  const problems: string[] = [];
  const blocks = [...gt.blocks].sort((a, b) => a.order - b.order);
  const of = (type: Block['type']) => blocks.filter(b => b.type === type);
  const same = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${what}: gt.json ${JSON.stringify(actual)}, data ${JSON.stringify(expected)}`,
      );
    }
  };

  same(
    'landscape pages',
    gt.pages.every(page => page.width > page.height),
    true,
  );
  // The running header and footer: once on every page, with the data's text.
  for (const [type, want] of [
    ['page_header', `${record.company}　客戶別銷貨明細表`],
    ['page_footer', `${record.company}　統一編號：${record.businessId}`],
  ] as const) {
    same(
      `${type} pages`,
      of(type).map(b => b.page),
      gt.pages.map((_, i) => i + 1),
    );
    for (const block of of(type)) same(type, squash(block.text), squash(want));
  }

  const tables = of('table') as TableBlock[];
  const firsts = tables.filter(table => table.continues === undefined);
  const firstText = (table: TableBlock) =>
    squash(table.table.cells[0]?.text ?? '');
  same('tables', firsts.map(firstText), ['客戶名稱', '負責人']);
  const [statement, signers] = firsts;
  if (statement === undefined || signers === undefined) return problems;

  // 每頁表頭重複: every fragment, on every page it prints on, starts with the
  // whole three-row header, and nothing else is a header cell.
  const parts = fragments(statement, tables);
  same(
    'statement pages',
    parts.map(part => part.page),
    parts.map((_, i) => statement.page + i),
  );
  for (const part of parts) {
    same(
      `header on page ${part.page}`,
      part.table.cells
        .filter(cell => cell.header)
        .map(cell =>
          [cell.row, cell.col, cell.rowSpan, cell.colSpan]
            .join(',')
            .concat(':', squash(cell.text)),
        ),
      header.map(squash),
    );
    same(`columns on page ${part.page}`, part.table.cols, 11);
  }
  // 欄寬: every fragment's columns span the x ranges they do on the first
  // page, within a point.
  const firstRanges = columnRanges(statement);
  for (const part of parts.slice(1)) {
    const ranges = columnRanges(part);
    for (let col = 0; col < 11; col++) {
      const want = firstRanges.get(col);
      const got = ranges.get(col);
      if (
        want === undefined ||
        got === undefined ||
        Math.abs(got[0] - want[0]) > 1 ||
        Math.abs(got[1] - want[1]) > 1
      ) {
        problems.push(
          `column ${col} on page ${part.page}: x ${JSON.stringify(got)}, page ${statement.page} ${JSON.stringify(want)}`,
        );
      }
    }
  }
  same('statement rows', parts.flatMap(bodyRows), expectedRows(record));
  same('signer rows', fragments(signers, tables).flatMap(bodyRows), [
    [
      record.signers.chairman,
      record.signers.manager,
      record.signers.accountant,
      record.signers.preparer,
    ],
  ]);
  return problems;
}

const decoder = new TextDecoder();
const json = (bytes: Uint8Array | undefined): unknown =>
  bytes === undefined ? undefined : JSON.parse(decoder.decode(bytes));

const uploaded = (await (
  await api('/api/templates', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: zipPack(),
  })
).json()) as { id: string; version: number };
console.log(`uploaded ${uploaded.id} version ${uploaded.version}`);

const batch = (await (
  await api('/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: uploaded.id,
      templateVersion: uploaded.version,
      count: Number(values.count),
      seed: values.seed,
    }),
  })
).json()) as { id: string };
console.log(`batch ${batch.id}, seed ${values.seed}, count ${values.count}`);

let status = '';
const deadline = Date.now() + 15 * 60_000;
while (status !== 'completed' && status !== 'failed') {
  if (Date.now() > deadline) throw new Error('batch did not finish in time');
  await new Promise(resolve => setTimeout(resolve, 3000));
  ({ status } = (await (await api(`/api/batches/${batch.id}`)).json()) as {
    status: string;
  });
}
console.log(`batch ${status}`);

const { fixtures } = (await (
  await api(`/api/batches/${batch.id}/fixtures`)
).json()) as {
  fixtures: {
    index: number;
    status: string;
    check?: { passed: boolean; differences: number };
  }[];
};
const zip = unzipSync(
  new Uint8Array(
    await (await api(`/api/batches/${batch.id}/zip`)).arrayBuffer(),
  ),
);

let failures = 0;
// Fixtures whose statement table runs across pages.
let split = 0;
for (const fixture of fixtures) {
  const folder = String(fixture.index).padStart(4, '0');
  const gt = json(zip[`${folder}/gt.json`]) as GroundTruth | undefined;
  const record = json(zip[`${folder}/data.json`]) as Statement | undefined;
  const problems = [
    ...(fixture.status === 'completed' ? [] : [`status ${fixture.status}`]),
    ...(fixture.check?.passed
      ? []
      : [`self-check ${JSON.stringify(fixture.check ?? null)}`]),
    ...(gt && record ? compare(gt, record) : ['gt.json or data.json missing']),
  ];
  if (problems.length > 0) failures += 1;
  const statementPages =
    gt?.blocks.filter(
      block =>
        block.type === 'table' &&
        (block.continues !== undefined ||
          gt.blocks.some(
            other => other.type === 'table' && other.continues === block.id,
          )),
    ).length ?? 0;
  if (statementPages > 1) split += 1;
  const summary =
    gt && record
      ? `${gt.pages.length} page(s), ${Object.values(record.regions).reduce(
          (n, region) => n + region.customers.length,
          0,
        )} customers, ${gt.blocks.filter(block => block.type === 'table').length} table block(s)`
      : '';
  console.log(
    `${folder} ${problems.length === 0 ? 'ok' : 'FAIL'} ${summary}${problems
      .map(problem => `\n  ${problem}`)
      .join('')}`,
  );
}
console.log(
  `${fixtures.length - failures}/${fixtures.length} fixtures pass self-check and print the header, footer, repeated table header and rows their data asks for; ${split} split across pages`,
);
process.exit(
  failures === 0 && split > 0 && fixtures.length === Number(values.count)
    ? 0
    : 1,
);
