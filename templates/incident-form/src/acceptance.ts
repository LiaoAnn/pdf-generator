// T23 acceptance on a running stack: zips pack/, uploads it, prints a batch
// and checks it. Passes when every fixture's self-check passes and every
// gt.json records the merged cells, ROC dates, checkboxes and blanks its
// ISO-date data.json asks for.
//   pnpm --filter @pdf-generator/incident-form acceptance -- \
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
    seed: { type: 'string', default: 't23-acceptance' },
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

type Injured = { hospitalized: boolean; note: string | null };
type IncidentRecord = {
  reportDate: string;
  reporter: { extension: number | null };
  incident: {
    date: string;
    place: string | null;
    category: string;
    severity: string;
  };
  hazards: Record<string, boolean>;
  actions: Record<string, boolean>;
  injured: Injured[];
  witness: { name: string | null; phone: string | null };
  remarks: string | null;
  approval: { date: string | null };
};

const single = (options: string[], value: string): [string, boolean][] =>
  options.map(option => [option, option === value]);
const multiple = (
  labels: string[],
  keys: string[],
  states: Record<string, boolean>,
): [string, boolean][] =>
  labels.map((label, i) => [label, states[keys[i] ?? ''] === true]);

/** The checkboxes the data asks for, in print order: [label, checked]. */
function expectedCheckboxes(record: IncidentRecord): [string, boolean][] {
  return [
    ...single(
      ['跌倒', '墜落', '被夾被捲', '切割擦傷', '感電', '化學品接觸', '其他'],
      record.incident.category,
    ),
    ...multiple(
      ['機械設備', '電氣', '化學物質', '高處作業', '火災爆炸'],
      ['machinery', 'electrical', 'chemical', 'height', 'fire'],
      record.hazards,
    ),
    ...single(['輕傷', '重傷', '死亡'], record.incident.severity),
    ...multiple(
      ['停工', '通報勞動檢查機構', '報警', '通知家屬'],
      ['stopWork', 'laborInspection', 'police', 'family'],
      record.actions,
    ),
    ...record.injured.flatMap((person): [string, boolean][] => [
      ['是', person.hospitalized],
      ['否', !person.hospitalized],
    ]),
  ];
}

const blankable = (record: IncidentRecord): [string, unknown][] => [
  ['分機', record.reporter.extension],
  ['場所', record.incident.place],
  ['目擊者', record.witness.name],
  ['目擊者電話', record.witness.phone],
  ['備註', record.remarks],
  ['簽核日期', record.approval.date],
  ['主管簽章', null],
];

function rocText(iso: string | null): string {
  if (iso === null) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`data.json date must stay ISO YYYY-MM-DD: ${iso}`);
  }
  const [year = 0, month = 0, day = 0] = iso.split('-').map(Number);
  return `民國${year - 1911}年${month}月${day}日`;
}

/** What is wrong with one fixture's gt.json against its data.json. */
function compare(gt: GroundTruth, record: IncidentRecord): string[] {
  const problems: string[] = [];
  const tables = gt.blocks
    .filter(block => block.type === 'table')
    .sort((a, b) => a.order - b.order);
  const checkboxes = tables.flatMap(table =>
    table.table.cells.flatMap(cell =>
      (cell.checkboxes ?? []).map((checkbox): [string, boolean] => [
        checkbox.text,
        checkbox.checked,
      ]),
    ),
  );
  const expected = expectedCheckboxes(record);
  if (JSON.stringify(checkboxes) !== JSON.stringify(expected)) {
    problems.push(
      `checkboxes ${JSON.stringify(checkboxes)}, data asks for ${JSON.stringify(expected)}`,
    );
  }
  const form = tables[0]?.table.cells ?? [];
  const reportDates = gt.blocks
    .filter(
      block => block.type === 'field' && block.text.startsWith('通報日期：'),
    )
    .map(block => block.text);
  const wantReport = `通報日期：中華${rocText(record.reportDate)}`;
  if (JSON.stringify(reportDates) !== JSON.stringify([wantReport])) {
    problems.push(
      `通報日期: gt.json ${JSON.stringify(reportDates)}, expected ${JSON.stringify(wantReport)}`,
    );
  }
  // The merged cells: three section rows across all five columns, and
  // 事故地點 over its 地址 and 場所 rows.
  const spans = (text: string) =>
    form
      .filter(cell => cell.text.replace(/\s/g, '') === text)
      .map(cell => [cell.rowSpan, cell.colSpan]);
  for (const [text, span] of [
    ['一、事業單位及通報人資料', [1, 5]],
    ['二、事故概況', [1, 5]],
    ['三、處置情形', [1, 5]],
    ['事故地點', [2, 1]],
  ] as const) {
    if (JSON.stringify(spans(text)) !== JSON.stringify([span])) {
      problems.push(
        `${text}: [rowSpan, colSpan] ${JSON.stringify(spans(text))}, expected ${JSON.stringify([span])}`,
      );
    }
  }
  const injuredRows = tables
    .slice(1)
    .flatMap(table => table.table.cells.filter(cell => !cell.header));
  const expectedCells: [string, unknown][] = [
    ...blankable(record).filter(([label]) => label !== '簽核日期'),
    ['發生日期', rocText(record.incident.date)],
    ['簽核日期', rocText(record.approval.date)],
  ];
  for (const [label, value] of expectedCells) {
    const labelCell = form.find(cell => cell.text.replace(/\s/g, '') === label);
    const valueCell = form.find(
      cell =>
        labelCell !== undefined &&
        cell.row === labelCell.row &&
        cell.col === labelCell.col + labelCell.colSpan,
    );
    const want = value === null ? '' : String(value);
    if (valueCell === undefined) {
      problems.push(`no value cell after ${label}`);
    } else if (valueCell.text !== want) {
      problems.push(
        `${label}: gt.json ${JSON.stringify(valueCell.text)}, data ${JSON.stringify(want)}`,
      );
    }
  }
  // The note is the last cell of each injured row.
  const notes = injuredRows.filter(cell => cell.col === 5);
  const wantNotes = record.injured.map(person => person.note ?? '');
  if (
    JSON.stringify(notes.map(cell => cell.text)) !== JSON.stringify(wantNotes)
  ) {
    problems.push(
      `injured notes ${JSON.stringify(notes.map(cell => cell.text))}, data ${JSON.stringify(wantNotes)}`,
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
  const record = json(zip[`${folder}/data.json`]) as IncidentRecord | undefined;
  const problems = [
    ...(fixture.status === 'completed' ? [] : [`status ${fixture.status}`]),
    ...(fixture.check?.passed
      ? []
      : [`self-check ${JSON.stringify(fixture.check ?? null)}`]),
    ...(gt && record ? compare(gt, record) : ['gt.json or data.json missing']),
  ];
  if (problems.length > 0) failures += 1;
  const summary = gt
    ? `${gt.pages.length} page(s), ${record?.injured.length} injured, ${
        record ? blankable(record).filter(([, v]) => v === null).length : 0
      } blank(s)`
    : '';
  console.log(
    `${folder} ${problems.length === 0 ? 'ok' : 'FAIL'} ${summary}${problems
      .map(problem => `\n  ${problem}`)
      .join('')}`,
  );
}
console.log(
  `${fixtures.length - failures}/${fixtures.length} fixtures pass self-check and record merged cells, ROC dates, checkboxes and blanks as expected`,
);
process.exit(
  failures === 0 && fixtures.length === Number(values.count) ? 0 : 1,
);
