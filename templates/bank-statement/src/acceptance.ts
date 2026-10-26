// T26 acceptance on a running stack: zips pack/, uploads it, prints a batch
// and checks it. Passes when every fixture's self-check passes and every
// gt.json prints ROC dates matching data.json's ISO dates, in date order,
// with each balance equal to
// the previous one plus the row's deposit minus its withdrawal (recomputed
// here from data.json, not read from it), the summary totals, the logo and
// the barcode with its number.
//   pnpm --filter @pdf-generator/bank-statement acceptance \
//     --url https://app-<wt>.pdf-generator.liaoann.net [--count 10] [--seed t23]
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
    seed: { type: 'string', default: 't26-acceptance' },
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

type Statement = {
  bank: { name: string };
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  opening: number;
  statementDigits: number[];
  transactions: {
    date: string;
    withdrawal: number | null;
    deposit: number | null;
  }[];
};

type Cell = Extract<GroundTruth['blocks'][number], { type: 'table' }>;

/** A printed amount (`1,234,567`, or empty for none) in whole dollars. */
function amount(text: string): bigint {
  const digits = text.replace(/\s/g, '');
  if (digits === '') return 0n;
  if (!/^-?\d{1,3}(,\d{3})*$/.test(digits)) {
    throw new Error(`not a printed amount: ${JSON.stringify(text)}`);
  }
  return BigInt(digits.replace(/,/g, ''));
}

const cellText = (cells: Cell['table']['cells'], row: number, col: number) =>
  cells.find(cell => cell.row === row && cell.col === col)?.text ?? '';

function roc(iso: string, style: 'slash' | 'text'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(
      `data.json date is not ISO YYYY-MM-DD: ${JSON.stringify(iso)}`,
    );
  }
  const year = Number(iso.slice(0, 4)) - 1911;
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  return style === 'slash'
    ? `${String(year).padStart(3, '0')}/${month}/${day}`
    : `民國${year}年${Number(month)}月${Number(day)}日`;
}

/** What is wrong with one fixture's gt.json against its data.json. */
function compare(gt: GroundTruth, record: Statement): string[] {
  const problems: string[] = [];
  const blocks = [...gt.blocks].sort((a, b) => a.order - b.order);
  const expectedHeader = `${record.bank.name}　綜合存款對帳單　對帳期間 ${roc(record.periodStart, 'slash')} 至 ${roc(record.periodEnd, 'slash')}`;
  for (const header of blocks.filter(block => block.type === 'page_header')) {
    if (header.text !== expectedHeader) {
      problems.push(
        `page ${header.page} page_header: printed ${JSON.stringify(header.text)}, expected ${JSON.stringify(expectedHeader)}`,
      );
    }
  }
  const tables = blocks.filter(
    (block): block is Cell => block.type === 'table',
  );
  const isTransactions = (table: Cell) =>
    table.table.cells.some(
      cell => cell.header && cell.text.trim() === '交易日期',
    );
  const summary = tables.find(table => !isTransactions(table));
  // The transaction rows, in print order across the page fragments.
  const rows = tables.filter(isTransactions).flatMap(table => {
    const { cells } = table.table;
    const body = [
      ...new Set(cells.filter(cell => !cell.header).map(cell => cell.row)),
    ].sort((a, b) => a - b);
    return body.map(row => ({
      date: cellText(cells, row, 0).trim(),
      withdrawal: cellText(cells, row, 2),
      deposit: cellText(cells, row, 3),
      balance: cellText(cells, row, 4),
    }));
  });
  if (rows.length !== record.transactions.length) {
    problems.push(
      `${rows.length} transaction rows printed, data has ${record.transactions.length}`,
    );
  }
  const dates = rows.map(row => row.date);
  // Numeric keys keep ordering meaningful even across ROC year widths.
  const dateKeys = dates.map(date => {
    const match = /^(\d{3,})\/(\d{2})\/(\d{2})$/.exec(date);
    return match
      ? Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3])
      : Number.NaN;
  });
  if (
    dateKeys.some(
      (key, i) =>
        !Number.isFinite(key) || (i > 0 && key < (dateKeys[i - 1] ?? 0)),
    )
  ) {
    problems.push(`transactions not in date order: ${dates.join(' ')}`);
  }
  // 餘額逐筆對: each printed balance is the previous balance plus the printed
  // deposit minus the printed withdrawal, starting from data.json's opening,
  // and the printed amounts are data.json's.
  let balance = BigInt(record.opening);
  let deposits = 0n;
  let withdrawals = 0n;
  rows.forEach((row, i) => {
    const want = record.transactions[i];
    const expectedDate = want && roc(want.date, 'slash');
    if (row.date !== expectedDate) {
      problems.push(
        `row ${i + 1}: 交易日期 printed ${JSON.stringify(row.date)}, expected ${JSON.stringify(expectedDate)}`,
      );
    }
    const deposit = amount(row.deposit);
    const withdrawal = amount(row.withdrawal);
    if (
      want === undefined ||
      deposit !== BigInt(want.deposit ?? 0) ||
      withdrawal !== BigInt(want.withdrawal ?? 0) ||
      (want.deposit === null) !== (row.deposit.trim() === '') ||
      (want.withdrawal === null) !== (row.withdrawal.trim() === '')
    ) {
      problems.push(
        `row ${i + 1}: printed ${JSON.stringify([row.withdrawal, row.deposit])}, data ${JSON.stringify([want?.withdrawal, want?.deposit])}`,
      );
    }
    balance += deposit - withdrawal;
    deposits += deposit;
    withdrawals += withdrawal;
    if (amount(row.balance) !== balance) {
      problems.push(
        `row ${i + 1}: balance ${row.balance}, expected ${balance.toLocaleString('en-US')}`,
      );
    }
  });
  const summaryCells = summary?.table.cells ?? [];
  const valueAfter = (label: string) => {
    const at = summaryCells.find(cell => cell.text.trim() === label);
    return at === undefined
      ? undefined
      : cellText(summaryCells, at.row, at.col + at.colSpan);
  };
  for (const [label, want] of [
    [
      '對帳期間',
      `${roc(record.periodStart, 'slash')} 至 ${roc(record.periodEnd, 'slash')}`,
    ],
    ['製表日期', roc(record.issueDate, 'text')],
  ] as const) {
    const printed = valueAfter(label)?.trim();
    if (printed !== want) {
      problems.push(
        `${label}: printed ${JSON.stringify(printed)}, expected ${JSON.stringify(want)}`,
      );
    }
  }
  for (const [label, want] of [
    ['期初餘額', BigInt(record.opening)],
    ['存入合計', deposits],
    ['支出合計', withdrawals],
    ['期末餘額', balance],
  ] as const) {
    const printed = valueAfter(label);
    if (printed === undefined || amount(printed) !== want) {
      problems.push(
        `${label}: printed ${JSON.stringify(printed)}, expected ${want.toLocaleString('en-US')}`,
      );
    }
  }
  const logos = blocks.filter(block => block.type === 'image');
  if (logos.length !== 1 || logos[0]?.page !== 1) {
    problems.push(
      `logo: ${logos.length} image block(s), pages ${logos.map(block => block.page)}`,
    );
  }
  const barcodes = blocks.filter(block => block.type === 'barcode');
  const barcode = barcodes[0];
  const number = barcode && blocks[blocks.indexOf(barcode) + 1];
  const wantNumber = `*${record.statementDigits.join('')}*`;
  if (
    barcodes.length !== 1 ||
    barcode?.page !== 1 ||
    barcode.text !== '' ||
    number?.text.trim() !== wantNumber
  ) {
    problems.push(
      `barcode: ${barcodes.length} block(s) on pages ${barcodes.map(block => block.page)}, number ${JSON.stringify(number?.text)}, expected ${wantNumber}`,
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
  const record = json(zip[`${folder}/data.json`]) as Statement | undefined;
  const problems = [
    ...(fixture.status === 'completed' ? [] : [`status ${fixture.status}`]),
    ...(fixture.check?.passed
      ? []
      : [`self-check ${JSON.stringify(fixture.check ?? null)}`]),
    ...(gt && record ? compare(gt, record) : ['gt.json or data.json missing']),
  ];
  if (problems.length > 0) failures += 1;
  const summary = gt
    ? `${gt.pages.length} page(s), ${record?.transactions.length} transaction(s)`
    : '';
  console.log(
    `${folder} ${problems.length === 0 ? 'ok' : 'FAIL'} ${summary}${problems
      .map(problem => `\n  ${problem}`)
      .join('')}`,
  );
}
console.log(
  `${fixtures.length - failures}/${fixtures.length} fixtures pass self-check and print every ROC date, balance, total, the logo and the barcode as expected`,
);
process.exit(
  failures === 0 && fixtures.length === Number(values.count) ? 0 : 1,
);
