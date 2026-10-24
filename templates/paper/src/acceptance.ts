// T25 acceptance on a running stack: zips pack/, uploads it, prints a batch
// and checks it. Passes when every fixture's self-check passes and every
// gt.json agrees with its data.json (src/compare.ts): each formula's LaTeX,
// the numbered references, the first-page footnotes and the two columns.
//   pnpm --filter @pdf-generator/paper acceptance -- \
//     --url https://app-<wt>.pdf-generator.liaoann.net [--count 10] [--seed t25]
// Signs in with the local Access stand-in's service token (vite dev only).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { GroundTruth } from '@pdf-generator/contract';
import { unzipSync, zipSync } from 'fflate';
import { compare, type PaperRecord } from './compare.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    count: { type: 'string', default: '10' },
    seed: { type: 'string', default: 't25-acceptance' },
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
const seen = new Set<string>();
for (const fixture of fixtures) {
  const folder = String(fixture.index).padStart(4, '0');
  const gt = json(zip[`${folder}/gt.json`]) as GroundTruth | undefined;
  const record = json(zip[`${folder}/data.json`]) as PaperRecord | undefined;
  const problems = [
    ...(fixture.status === 'completed' ? [] : [`status ${fixture.status}`]),
    ...(fixture.check?.passed
      ? []
      : [`self-check ${JSON.stringify(fixture.check ?? null)}`]),
    ...(gt && record ? compare(gt, record) : ['gt.json or data.json missing']),
  ];
  if (problems.length > 0) failures += 1;
  const options = record
    ? `eq ${record.eq1}${record.eq2}${record.eq3}${record.eq4}`
    : '';
  for (const slot of ['eq1', 'eq2', 'eq3', 'eq4'] as const) {
    if (record) seen.add(`${slot}:${record[slot]}`);
  }
  const summary = gt
    ? `${gt.pages.length} page(s), ${options}, ${record?.references.length} references (${record?.references.filter(r => r.kind === 'en').length} en)`
    : '';
  console.log(
    `${folder} ${problems.length === 0 ? 'ok' : 'FAIL'} ${summary}${problems
      .map(problem => `\n  ${problem}`)
      .join('')}`,
  );
}
// Fonts are checked per printed formula, so an option no fixture printed
// had its KaTeX faces checked only by build.test.ts.
console.log(
  `formula options printed: ${seen.size}/12 (${[...seen].sort().join(' ')})`,
);
console.log(
  `${fixtures.length - failures}/${fixtures.length} fixtures pass self-check and match their data (formulas, references, footnotes, columns)`,
);
process.exit(
  failures === 0 && fixtures.length === Number(values.count) ? 0 : 1,
);
