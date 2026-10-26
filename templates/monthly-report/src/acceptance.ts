// T22 acceptance on a running stack: zips pack/, uploads it, prints a batch
// and checks it. Passes when every fixture's self-check passes, every page
// has the running header, footer and correct page number in gt.json, and the lists, tables,
// figure and remarks in gt.json are the ones its data.json asks for.
//   pnpm --filter @pdf-generator/monthly-report acceptance \
//     --url https://app-<wt>.pdf-generator.liaoann.net [--count 10] [--seed t22]
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
    seed: { type: 'string', default: 't22-acceptance' },
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

type Report = {
  company: string;
  period: { year: number; month: number };
  preparedBy: { department: string };
  highlights: string[];
  nextSteps: string[];
  figure: { caption: string; body: string };
  departments: {
    name: string;
    revenue: number;
    cost: number;
    headcount: number;
  }[];
  totals: { revenue: number; cost: number; headcount: number };
  projects: {
    title: string;
    owner: string;
    due: string;
    progress: number;
    status: string;
  }[];
  remarks: string | null;
};

const grouped = (value: number) => value.toLocaleString('en-US');
const squash = (text: string) => text.replace(/\s+/g, '');

/** The body rows the data asks for in each table, keyed by its first header. */
function expectedRows(record: Report): Record<string, string[][]> {
  return {
    部門: [
      ...record.departments.map(row => [
        row.name,
        grouped(row.revenue),
        grouped(row.cost),
        String(row.headcount),
      ]),
      [
        '合計',
        grouped(record.totals.revenue),
        grouped(record.totals.cost),
        String(record.totals.headcount),
      ],
    ],
    專案名稱: record.projects.map(row => [
      row.title,
      row.owner,
      row.due,
      `${row.progress}%`,
      row.status,
    ]),
  };
}

type Block = GroundTruth['blocks'][number];
type TableBlock = Extract<Block, { type: 'table' }>;

/** Body rows of a table and every block that continues it, in print order. */
function bodyRows(first: TableBlock, tables: TableBlock[]): string[][] {
  const parts = [first];
  for (;;) {
    const last = parts.at(-1);
    const next = tables.find(table => table.continues === last?.id);
    if (next === undefined) break;
    parts.push(next);
  }
  return parts.flatMap(part => {
    const rows = new Map<number, string[]>();
    for (const cell of part.table.cells) {
      if (cell.header) continue;
      const row = rows.get(cell.row) ?? [];
      row[cell.col] = squash(cell.text);
      rows.set(cell.row, row);
    }
    return [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
  });
}

/** What is wrong with one fixture's gt.json against its data.json. */
function compare(gt: GroundTruth, record: Report): string[] {
  const problems: string[] = [];
  const blocks = [...gt.blocks].sort((a, b) => a.order - b.order);
  const of = (type: Block['type']) => blocks.filter(b => b.type === type);
  const texts = (type: Block['type']) => of(type).map(b => squash(b.text));
  const same = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${what}: gt.json ${JSON.stringify(actual)}, data ${JSON.stringify(expected)}`,
      );
    }
  };

  // The running header and footer: once on every page, with the data's text.
  const header = squash(
    `${record.company}　${record.period.year} 年 ${record.period.month} 月營運月報`,
  );
  const footer = squash(
    `內部資料　請勿外流　編製單位：${record.preparedBy.department}`,
  );
  for (const [type, want] of [
    ['page_header', header],
    ['page_footer', footer],
  ] as const) {
    const pages = of(type).map(b => b.page);
    same(
      `${type} pages`,
      pages,
      gt.pages.map((_, i) => i + 1),
    );
    for (const text of texts(type)) same(type, text, want);
  }

  // Catches missing/duplicate page numbers, wrong clone numbers, stale totals
  // and punctuation changes even when the PDF and GT agree with each other.
  const pageNumbers = of('page_number');
  same(
    'page_number pages',
    pageNumbers.map(block => block.page).sort((a, b) => a - b),
    gt.pages.map((_, index) => index + 1),
  );
  for (const block of pageNumbers) {
    same(
      `page_number page ${block.page}`,
      squash(block.text),
      `第${block.page}頁，共${gt.pages.length}頁`,
    );
  }

  same(
    'list items',
    texts('list_item'),
    [...record.highlights, ...record.nextSteps].map(squash),
  );
  same('images', of('image').length, 1);
  same('caption', texts('caption'), [squash(record.figure.caption)]);
  const paragraphs = texts('paragraph');
  for (const [what, text] of [
    ['figure text', record.figure.body],
    ['remarks', record.remarks],
  ] as const) {
    if (text !== null && !paragraphs.includes(squash(text))) {
      problems.push(`${what} is not a paragraph block`);
    }
  }
  same(
    'remarks heading',
    texts('heading').includes('備註'),
    record.remarks !== null,
  );

  const tables = of('table') as TableBlock[];
  const firsts = tables.filter(table => table.continues === undefined);
  const want = expectedRows(record);
  same(
    'tables',
    firsts.map(table => squash(table.table.cells[0]?.text ?? '')),
    Object.keys(want),
  );
  for (const table of firsts) {
    const key = squash(table.table.cells[0]?.text ?? '');
    same(
      `${key} rows`,
      bodyRows(table, tables),
      (want[key] ?? []).map(row => row.map(squash)),
    );
  }
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
for (const fixture of fixtures) {
  const folder = String(fixture.index).padStart(4, '0');
  const gt = json(zip[`${folder}/gt.json`]) as GroundTruth | undefined;
  const record = json(zip[`${folder}/data.json`]) as Report | undefined;
  const problems = [
    ...(fixture.status === 'completed' ? [] : [`status ${fixture.status}`]),
    ...(fixture.check?.passed
      ? []
      : [`self-check ${JSON.stringify(fixture.check ?? null)}`]),
    ...(gt && record ? compare(gt, record) : ['gt.json or data.json missing']),
  ];
  if (problems.length > 0) failures += 1;
  const summary =
    gt && record
      ? `${gt.pages.length} page(s), ${record.departments.length} departments, ${record.projects.length} projects, ${
          gt.blocks.filter(block => block.type === 'table').length
        } table block(s), remarks ${record.remarks === null ? 'blank' : 'printed'}`
      : '';
  console.log(
    `${folder} ${problems.length === 0 ? 'ok' : 'FAIL'} ${summary}${problems
      .map(problem => `\n  ${problem}`)
      .join('')}`,
  );
}
console.log(
  `${fixtures.length - failures}/${fixtures.length} fixtures pass self-check and print correct page numbers and the header, footer, lists, figure and tables their data asks for`,
);
process.exit(
  failures === 0 && fixtures.length === Number(values.count) ? 0 : 1,
);
