// dump-gt: uploads template packs to the LOCAL stack's apps/web public API,
// runs one batch per pack and saves every fixture's gt.json (without
// source.templateVersion) and check.json, plus a deterministic summary.json
// (object keys sorted, no batch ids, versions, URLs or timestamps anywhere
// in the output, so two runs of the same code are byte-identical). The CLI
// entry point is dump-gt-cli.ts.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Batch,
  FixtureList,
  TemplateSummary,
} from '@pdf-generator/contract';
import { slugSchema } from '@pdf-generator/contract';
import { zipSync } from 'fflate';

export interface DumpGtOptions {
  url: string;
  out: string;
  seed: string;
  count: number;
  pollMs: number;
  /** Pack folders; with none, every templates/<name>/pack of the repo. */
  packs: string[];
}

/** True when url may receive the local Access token: http(s) on localhost,
 * an IPv4 in 127.0.0.0/8, or [::1]. Anything else is refused — a worktree
 * URL (<route>-<wt>.<vm>.liaoann.net) reaches other worktrees' stacks too,
 * and the tool runs inside its own stack, where loopback is its own server. */
export function isLocalOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (host === 'localhost' || host === '[::1]') return true;
  return /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

const accessHeaders = {
  'CF-Access-Client-Id': 'local-dev.access',
  'CF-Access-Client-Secret': 'local-dev-secret',
};

/** fetch one API route; throws unless the answer is 2xx. No redirect is
 * followed: the local Access token must never leave the origin it was
 * given, so a redirect fails the run without a request to its target. */
async function api(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { ...accessHeaders, ...init.headers },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

/** The pack folder zipped, files at the zip root, '/'-separated paths. */
async function packZip(dir: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), relative);
      } else if (entry.isFile()) {
        files[relative] = await readFile(join(current, entry.name));
      }
    }
  };
  await walk(dir, '');
  return zipSync(files);
}

/** A copy of value with object keys sorted (array order kept). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(sorted(value), null, 2)}\n`);
}

/** Every templates/<name>/pack under the repo root, in name order. The repo
 * root is relative to this module file, not the cwd. */
async function defaultPacks(): Promise<string[]> {
  const templates = join(
    fileURLToPath(new URL('../../../', import.meta.url)),
    'templates',
  );
  const packs: string[] = [];
  for (const entry of await readdir(templates, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = join(templates, entry.name, 'pack');
    if ((await stat(folder).catch(() => undefined))?.isDirectory()) {
      packs.push(folder);
    }
  }
  return packs.sort();
}

/** Runs the whole dump; returns the process exit code (0: every fixture
 * completed and passed its self-check, 1 otherwise; files are written
 * either way). Throws on any failed request. */
export async function dumpGt(options: DumpGtOptions): Promise<number> {
  const base = options.url.replace(/\/+$/, '');
  const packs = options.packs.length > 0 ? options.packs : await defaultPacks();
  const templates: Record<string, { fixtures: FixtureList['fixtures'] }> = {};
  let all = 0;
  let completed = 0;
  let checked = 0;
  let failures = 0;
  for (const pack of packs) {
    const uploaded = (await (
      await api(base, '/api/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: (await packZip(pack)) as Uint8Array<ArrayBuffer>,
      })
    ).json()) as TemplateSummary;
    // The id becomes an output folder name: only a contract slug is safe.
    if (!slugSchema.safeParse(uploaded.id).success) {
      throw new Error(
        `POST /api/templates returned an id that is not a slug: ${JSON.stringify(uploaded.id)}`,
      );
    }
    const batch = (await (
      await api(base, '/api/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateId: uploaded.id,
          templateVersion: uploaded.version,
          count: options.count,
          seed: options.seed,
        }),
      })
    ).json()) as Batch;
    const deadline = Date.now() + 15 * 60_000;
    let status: string = batch.status;
    while (status !== 'completed' && status !== 'failed') {
      if (Date.now() > deadline) {
        throw new Error(
          `GET /api/batches/${batch.id}: still ${status} after 15 minutes`,
        );
      }
      await new Promise(resolve => {
        setTimeout(resolve, options.pollMs);
      });
      ({ status } = (await (
        await api(base, `/api/batches/${batch.id}`)
      ).json()) as { status: string });
    }
    const list = (await (
      await api(base, `/api/batches/${batch.id}/fixtures`)
    ).json()) as FixtureList;
    for (const fixture of list.fixtures) {
      if (!Number.isSafeInteger(fixture.index) || fixture.index < 0) {
        throw new Error(
          `GET /api/batches/${batch.id}/fixtures: index is not a non-negative safe integer: ${JSON.stringify(fixture.index)}`,
        );
      }
    }
    templates[uploaded.id] = { fixtures: list.fixtures };
    let done = 0;
    let good = 0;
    for (const fixture of list.fixtures) {
      if (fixture.check?.passed === true) good += 1;
      if (fixture.status !== 'completed') {
        failures += 1;
        continue;
      }
      done += 1;
      if (fixture.check?.passed === false) {
        failures += 1;
      }
      const folder = join(
        options.out,
        uploaded.id,
        String(fixture.index).padStart(4, '0'),
      );
      await mkdir(folder, { recursive: true });
      const gt = (await (
        await api(
          base,
          `/api/batches/${batch.id}/fixtures/${fixture.index}/gt.json`,
        )
      ).json()) as Record<string, unknown>;
      const source = gt.source;
      if (typeof source === 'object' && source !== null) {
        delete (source as Record<string, unknown>).templateVersion;
      }
      await writeJson(join(folder, 'gt.json'), gt);
      const check = await (
        await api(
          base,
          `/api/batches/${batch.id}/fixtures/${fixture.index}/check.json`,
        )
      ).json();
      await writeJson(join(folder, 'check.json'), check);
    }
    all += list.fixtures.length;
    completed += done;
    checked += good;
    console.log(
      `${uploaded.id}: batch ${batch.id}, ${done}/${list.fixtures.length} completed, self-check ${good}/${list.fixtures.length}`,
    );
  }
  await writeJson(join(options.out, 'summary.json'), {
    count: options.count,
    seed: options.seed,
    templates,
  });
  console.log(
    `total: ${completed}/${all} completed, self-check ${checked}/${all}`,
  );
  return failures > 0 ? 1 : 0;
}
