// dump-gt end to end: the CLI against a fake batch API on 127.0.0.1, which
// answers like apps/web's public routes (upload, batch, poll, fixture list,
// one fixture's gt.json and check.json).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Batch,
  BatchRequest,
  Fixture,
  FixtureList,
  GroundTruth,
  TemplateSummary,
} from '@pdf-generator/contract';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLocalOrigin } from './dump-gt.ts';

const cli = fileURLToPath(new URL('./dump-gt-cli.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

/** What the fake API saw and how it should answer. */
interface Api {
  url: string;
  requests: { method: string; path: string }[];
  uploads: Record<string, Record<string, string>>;
  batches: BatchRequest[];
  /** Overrides a fixture of a template's batch (default: completed, passed). */
  fixture?: (templateId: string, index: number) => Partial<Fixture>;
  /** Final batch status (default completed). */
  finalStatus?: (templateId: string) => Batch['status'];
  /** Answers POST /api/templates with this error instead. */
  uploadError?: { status: number; body: unknown };
}

const accessHeaders = {
  'cf-access-client-id': 'local-dev.access',
  'cf-access-client-secret': 'local-dev-secret',
};

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function gtFor(
  templateId: string,
  templateVersion: number,
  seed: string,
  index: number,
): GroundTruth {
  // Keys deliberately out of alphabetical order.
  return {
    schemaVersion: 1,
    source: { templateId, templateVersion, seed, index },
    pages: [{ width: 595.28, height: 841.89 }],
    blocks: [
      {
        type: 'paragraph',
        id: `p-${index}`,
        page: 1,
        bbox: [10, 20.5, 300, 40.25],
        order: 0,
        text: `第${index}段`,
      },
    ],
  };
}

function startApi(): Promise<{ api: Api; server: Server }> {
  const versions = new Map<string, number>();
  const batchRequests = new Map<string, BatchRequest>();
  const polls = new Map<string, number>();
  const api: Api = { url: '', requests: [], uploads: {}, batches: [] };

  const fixtureOf = (batchId: string, index: number): Fixture => {
    const templateId = batchRequests.get(batchId)?.templateId ?? '';
    return {
      index,
      status: 'completed',
      check: { passed: true, differences: 0 },
      ...api.fixture?.(templateId, index),
    };
  };

  const server = createServer(async (request, response) => {
    const path = request.url ?? '';
    api.requests.push({ method: request.method ?? '', path });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    for (const [name, value] of Object.entries(accessHeaders)) {
      if (request.headers[name] !== value) {
        send(401, { error: { code: 'unauthorized', message: 'no token' } });
        return;
      }
    }
    if (request.method === 'POST' && path === '/api/templates') {
      if (request.headers['content-type'] !== 'application/zip') {
        send(415, { error: { code: 'unsupported', message: 'zip only' } });
        return;
      }
      const files = unzipSync(new Uint8Array(await body(request)));
      if (api.uploadError) {
        send(api.uploadError.status, api.uploadError.body);
        return;
      }
      const decoded = Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [
          name,
          Buffer.from(bytes).toString('utf8'),
        ]),
      );
      const { id } = JSON.parse(decoded['manifest.json'] ?? '{}') as {
        id: string;
      };
      api.uploads[id] = decoded;
      const version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      const summary: TemplateSummary = {
        id,
        version,
        name: id,
        page: { size: 'A4', orientation: 'portrait' },
        createdAt: new Date().toISOString(),
      };
      send(201, summary);
      return;
    }
    if (request.method === 'POST' && path === '/api/batches') {
      const requested = JSON.parse(
        (await body(request)).toString('utf8'),
      ) as BatchRequest;
      api.batches.push(requested);
      // Batch ids differ between runs, as real ones do.
      const id = `batch-${Math.random().toString(36).slice(2)}`;
      batchRequests.set(id, requested);
      const batch: Batch = {
        ...requested,
        id,
        status: 'queued',
        progress: { completed: 0, failed: 0, checkPassed: 0, checkFailed: 0 },
        createdAt: new Date().toISOString(),
      };
      send(201, batch);
      return;
    }
    const match =
      /^\/api\/batches\/([^/]+)(?:\/fixtures(?:\/(\d+)\/([^/]+))?)?$/.exec(
        path,
      );
    const batchId = match?.[1] ?? '';
    const requested = batchRequests.get(batchId);
    if (request.method !== 'GET' || !match || !requested) {
      send(404, { error: { code: 'not_found', message: path } });
      return;
    }
    const { templateId } = requested;
    const finished = (polls.get(batchId) ?? 0) >= 1;
    const [, , index, file] = match;
    if (!path.includes('/fixtures')) {
      polls.set(batchId, (polls.get(batchId) ?? 0) + 1);
      send(200, {
        id: batchId,
        status: finished
          ? (api.finalStatus?.(templateId) ?? 'completed')
          : 'running',
      });
      return;
    }
    if (!finished) {
      send(409, { error: { code: 'not_finished', message: 'poll first' } });
      return;
    }
    if (index === undefined) {
      const list: FixtureList = {
        batchId,
        fixtures: Array.from({ length: requested.count }, (_, k) =>
          fixtureOf(batchId, k),
        ),
      };
      send(200, list);
      return;
    }
    const fixture = fixtureOf(batchId, Number(index));
    if (fixture.status !== 'completed') {
      send(404, { error: { code: 'not_found', message: 'not completed' } });
      return;
    }
    if (file === 'gt.json') {
      send(
        200,
        gtFor(
          templateId,
          versions.get(templateId) ?? 0,
          requested.seed,
          Number(index),
        ),
      );
    } else if (file === 'check.json') {
      send(
        200,
        fixture.check?.passed
          ? { ok: true, differences: [] }
          : {
              ok: false,
              differences: [
                { kind: 'font', page: 1, font: 'Times', text: '第' },
              ],
            },
      );
    } else {
      send(404, { error: { code: 'not_found', message: path } });
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      api.url = `http://127.0.0.1:${port}`;
      resolve({ api, server });
    });
  });
}

let scratch: string;
let api: Api;
let server: Server;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dump-gt-'));
  ({ api, server } = await startApi());
});

afterEach(async () => {
  server.close();
  await rm(scratch, { recursive: true, force: true });
});

/** A pack folder with a manifest naming `id`, one file in a subfolder. */
async function pack(id: string): Promise<string> {
  const dir = join(scratch, 'packs', id);
  await mkdir(join(dir, 'styles'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id }));
  await writeFile(
    join(dir, 'template.hbs'),
    `<p data-gt="paragraph">${id}</p>`,
  );
  await writeFile(join(dir, 'styles', 'main.css'), 'p { margin: 0 }');
  return dir;
}

/** Every file under `dir`, by relative path, as text. */
async function tree(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile());
  return Object.fromEntries(
    await Promise.all(
      files.map(async entry => {
        const file = join(entry.parentPath, entry.name);
        return [
          file
            .slice(dir.length + 1)
            .split('\\')
            .join('/'),
          await readFile(file, 'utf8'),
        ] as const;
      }),
    ),
  );
}

const flags = (out: string, ...rest: string[]) => [
  '--url',
  api.url,
  '--out',
  out,
  '--poll-ms',
  '10',
  ...rest,
];

describe('dump-gt', () => {
  it('uploads each pack, runs a batch and saves every gt.json and check.json', async () => {
    const out = join(scratch, 'out');
    const result = await run(
      flags(
        out,
        '--seed',
        's1',
        '--count',
        '2',
        await pack('beta'),
        await pack('alpha'),
      ),
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    // The zip holds the pack's files at its root, '/'-separated.
    expect(api.uploads.alpha).toEqual({
      'manifest.json': JSON.stringify({ id: 'alpha' }),
      'template.hbs': '<p data-gt="paragraph">alpha</p>',
      'styles/main.css': 'p { margin: 0 }',
    });
    expect(Object.keys(api.uploads).sort()).toEqual(['alpha', 'beta']);
    // Each batch asks for the version its upload returned.
    expect(
      [...api.batches].sort((a, b) => a.templateId.localeCompare(b.templateId)),
    ).toEqual([
      { templateId: 'alpha', templateVersion: 1, count: 2, seed: 's1' },
      { templateId: 'beta', templateVersion: 1, count: 2, seed: 's1' },
    ]);

    const files = await tree(out);
    expect(Object.keys(files).sort()).toEqual([
      'alpha/0000/check.json',
      'alpha/0000/gt.json',
      'alpha/0001/check.json',
      'alpha/0001/gt.json',
      'beta/0000/check.json',
      'beta/0000/gt.json',
      'beta/0001/check.json',
      'beta/0001/gt.json',
      'summary.json',
    ]);
    // Keys sorted at every level, 2-space indent, trailing newline, and no
    // source.templateVersion.
    expect(files['alpha/0001/gt.json']).toBe(
      `${JSON.stringify(
        {
          blocks: [
            {
              bbox: [10, 20.5, 300, 40.25],
              id: 'p-1',
              order: 0,
              page: 1,
              text: '第1段',
              type: 'paragraph',
            },
          ],
          pages: [{ height: 841.89, width: 595.28 }],
          schemaVersion: 1,
          source: { index: 1, seed: 's1', templateId: 'alpha' },
        },
        null,
        2,
      )}\n`,
    );
    expect(files['beta/0000/check.json']).toBe(
      `${JSON.stringify({ differences: [], ok: true }, null, 2)}\n`,
    );
    expect(JSON.parse(files['summary.json'] ?? '')).toEqual({
      count: 2,
      seed: 's1',
      templates: {
        alpha: {
          fixtures: [
            {
              check: { differences: 0, passed: true },
              index: 0,
              status: 'completed',
            },
            {
              check: { differences: 0, passed: true },
              index: 1,
              status: 'completed',
            },
          ],
        },
        beta: {
          fixtures: [
            {
              check: { differences: 0, passed: true },
              index: 0,
              status: 'completed',
            },
            {
              check: { differences: 0, passed: true },
              index: 1,
              status: 'completed',
            },
          ],
        },
      },
    });
    expect(result.stdout).toMatch(/self-check 4\/4/);
  });

  it('writes byte-identical output for the same code, whatever the template version and batch ids', async () => {
    const packs = [await pack('alpha'), await pack('beta')];
    const first = join(scratch, 'first');
    const second = join(scratch, 'second');
    expect((await run(flags(first, '--count', '3', ...packs))).code).toBe(0);
    // The second upload of each pack becomes version 2.
    expect((await run(flags(second, '--count', '3', ...packs))).code).toBe(0);
    expect(api.batches.map(batch => batch.templateVersion).sort()).toEqual([
      1, 1, 2, 2,
    ]);
    const a = await tree(first);
    expect(Object.keys(a)).toHaveLength(13);
    expect(await tree(second)).toEqual(a);
    // Without --seed and --count the defaults apply: seed dump-gt.
    expect(JSON.parse(a['summary.json'] ?? '')).toMatchObject({
      count: 3,
      seed: 'dump-gt',
    });
  });

  it('dumps every templates/*/pack of the repo when no pack is given', async () => {
    const out = join(scratch, 'out');
    const result = await run(flags(out, '--count', '1'));
    expect(result.code).toBe(0);
    const summary = JSON.parse(
      await readFile(join(out, 'summary.json'), 'utf8'),
    );
    expect(Object.keys(summary.templates)).toEqual([
      'bank-statement',
      'financial-statement',
      'incident-form',
      'minimal-example',
      'monthly-report',
      'paper',
    ]);
    expect(api.uploads['minimal-example']?.['manifest.json']).toBe(
      await readFile(
        join(repoRoot, 'templates/minimal-example/pack/manifest.json'),
        'utf8',
      ),
    );
  });

  it('records failed fixtures and failed self-checks in the summary and exits 1', async () => {
    api.fixture = (templateId, index) =>
      templateId !== 'alpha'
        ? {}
        : index === 1
          ? {
              status: 'failed',
              error: 'print_failed: Chrome crashed',
              check: undefined,
            }
          : index === 2
            ? { check: { passed: false, differences: 1 } }
            : {};
    api.finalStatus = templateId =>
      templateId === 'alpha' ? 'failed' : 'completed';
    const out = join(scratch, 'out');
    const result = await run(
      flags(out, '--count', '3', await pack('alpha'), await pack('beta')),
    );
    expect(result.code).toBe(1);

    const files = await tree(out);
    expect(files['alpha/0001/gt.json']).toBeUndefined();
    expect(files['alpha/0001/check.json']).toBeUndefined();
    expect(files['alpha/0000/gt.json']).toBeDefined();
    expect(JSON.parse(files['alpha/0002/check.json'] ?? '')).toEqual({
      differences: [{ font: 'Times', kind: 'font', page: 1, text: '第' }],
      ok: false,
    });
    expect(files['beta/0002/gt.json']).toBeDefined();
    expect(JSON.parse(files['summary.json'] ?? '').templates.alpha).toEqual({
      fixtures: [
        {
          check: { differences: 0, passed: true },
          index: 0,
          status: 'completed',
        },
        { error: 'print_failed: Chrome crashed', index: 1, status: 'failed' },
        {
          check: { differences: 1, passed: false },
          index: 2,
          status: 'completed',
        },
      ],
    });
    expect(result.stdout).toMatch(/self-check 4\/6/);
  });

  it('exits 1 with the API error when a request fails', async () => {
    api.uploadError = {
      status: 400,
      body: {
        error: { code: 'invalid_manifest', message: 'manifest.json is wrong' },
      },
    };
    const result = await run(flags(join(scratch, 'out'), await pack('alpha')));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('400');
    expect(result.stderr).toContain('invalid_manifest');
  });

  it('refuses a non-local --url before any request', async () => {
    const out = join(scratch, 'out');
    const result = await run([
      '--url',
      'https://pdf-generator-web.example.invalid',
      '--out',
      out,
      await pack('alpha'),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/local/i);
    await expect(readdir(out)).rejects.toThrow();
  });

  it('refuses an output folder that is not empty, before any request', async () => {
    const out = join(scratch, 'out');
    await mkdir(out);
    await writeFile(join(out, 'old.txt'), 'keep me');
    const result = await run(flags(out, await pack('alpha')));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(out);
    expect(api.requests).toEqual([]);
    expect(await tree(out)).toEqual({ 'old.txt': 'keep me' });
    // An empty existing folder is fine.
    const empty = join(scratch, 'empty');
    await mkdir(empty);
    expect(
      (await run(flags(empty, '--count', '1', await pack('beta')))).code,
    ).toBe(0);
  });

  it('exits 2 with usage when --out is missing', async () => {
    const result = await run(['--url', api.url]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage/i);
    expect(api.requests).toEqual([]);
  });
});

describe('isLocalOrigin', () => {
  it.each([
    'http://127.0.0.1:8787',
    'http://127.0.0.2:8787/',
    'http://localhost:8787',
    'http://[::1]:8787',
    'https://app-t14-12-dump-gt.pdf-generator.liaoann.net',
    'https://app-t07-5-batch-pack-cache.pdf-generator.liaoann.net/',
  ])('accepts %s', url => {
    expect(isLocalOrigin(url)).toBe(true);
  });

  it.each([
    'https://pdf-generator-web.example.workers.dev',
    'https://example.com',
    'https://liaoann.net',
    'https://pdf-generator.liaoann.net',
    'https://a.b.c.liaoann.net',
    'https://app-x.pdf-generator.liaoann.net.example.com',
    'http://localhost.example.com:8787',
    'http://127.0.0.1.nip.io:8787',
    'http://10.0.0.5:8787',
    'ftp://127.0.0.1',
    'not a url',
  ])('refuses %s', url => {
    expect(isLocalOrigin(url)).toBe(false);
  });
});
