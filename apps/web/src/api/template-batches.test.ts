import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  batchSchema,
  fixtureListSchema,
  gtSchema,
  manifestSchema,
  rulesSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { type FixtureJob, makeFixture } from '../batch/fixture.ts';
import type { Printer } from '../batch/printer.ts';
import { handleFixtureMessages } from '../batch/queue.ts';
import * as schema from '../db/schema.ts';
import type { TemplatePack } from '../templates/source.ts';
import { templateStore } from '../templates/store.ts';
import { createFetchHandler } from '../worker.ts';

type Files = Record<string, Uint8Array>;
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let valid: Files;
const local = createLocalAccess();
const handle = createFetchHandler({
  pages: async () => new Response('Unexpected page handler', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
const create = vi.fn(async ({ id }: { id: string }) => ({ id }));
const print = vi.fn<Printer['print']>();

async function readPack(root: URL, prefix = ''): Promise<Files> {
  const files: Files = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(
        files,
        await readPack(new URL(`${entry.name}/`, root), `${path}/`),
      );
    } else {
      files[path] = new Uint8Array(await readFile(new URL(entry.name, root)));
    }
  }
  return files;
}

function text(files: Files, path: string): string {
  const bytes = files[path];
  if (!bytes) throw new Error(`Missing fixture file ${path}`);
  return strFromU8(bytes);
}

function pack(heading: string, approved = true) {
  const manifest = manifestSchema.parse(
    JSON.parse(text(valid, 'manifest.json')),
  );
  manifest.page.orientation = approved ? 'portrait' : 'landscape';
  // Reverse alphabetical order catches implementations that sort zip entries.
  manifest.files.styles = ['styles/z-first.css', 'styles/a-last.css'];
  const styles = [text(valid, 'styles/report.css'), 'body { color: #654321; }'];
  const template = text(valid, manifest.files.template)
    .replaceAll('公司月報', heading)
    .replace('../styles/report.css', '../styles/z-first.css');
  const rules = rulesSchema.parse(
    JSON.parse(text(valid, manifest.files.rules)),
  );
  rules.fields.revenue = { type: 'constant', value: 1234567 };
  rules.fields.approved = { type: 'constant', value: approved };
  rules.fields.rows = {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: {
      type: 'object',
      fields: {
        item: { type: 'constant', value: '版本支出' },
        amount: { type: 'constant', value: 2345 },
      },
    },
  };
  const sample = {
    ...JSON.parse(text(valid, manifest.files.sample)),
    company: `${heading}範例有限公司`,
    revenue: 1234567,
    approved,
    rows: [
      { item: '版本支出', amount: 2345 },
      { item: '版本支出', amount: 2345 },
    ],
  };
  const files = {
    ...valid,
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [manifest.files.template]: strToU8(template),
    [manifest.files.rules]: strToU8(JSON.stringify(rules)),
    [manifest.files.sample]: strToU8(JSON.stringify(sample)),
    'styles/z-first.css': strToU8(styles[0] ?? ''),
    'styles/a-last.css': strToU8(styles[1] ?? ''),
  };
  delete (files as Files)['styles/report.css'];
  return {
    files,
    decoded: {
      manifest,
      template,
      styles,
      rules,
      sample,
      files: Object.fromEntries(
        Object.entries(files).map(([path, bytes]) => [
          path,
          Buffer.from(bytes).toString('base64'),
        ]),
      ),
      fonts: [],
    },
  };
}

function request(path: string, body?: string | Uint8Array) {
  return handle(
    new Request(`https://web.example.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
        'content-type':
          typeof body === 'string' ? 'application/json' : 'application/zip',
      },
      body:
        typeof body === 'string' || body === undefined
          ? body
          : new Uint8Array(body),
    }),
    {
      ...platform.env,
      BATCH_WORKFLOW: { create } as unknown as Workflow<{ batchId: string }>,
    },
  );
}

async function upload(value: ReturnType<typeof pack>) {
  const response = await request('/api/templates', zipSync(value.files));
  expect(
    response.status,
    response.status === 201 ? undefined : await response.clone().text(),
  ).toBe(201);
  return templateSummarySchema.parse(await response.json());
}

function input(templateId: string, templateVersion: number) {
  return {
    templateId,
    templateVersion,
    count: 1,
    seed: 'T15_uploaded_versions',
  };
}

function db() {
  return drizzle(platform.env.DB, { schema });
}

async function stored(job: FixtureJob, file = 'data.json') {
  const object = await platform.env.FILES.get(
    `batches/${job.batchId}/0000/${file}`,
  );
  if (!object) throw new Error(`Missing fixture ${file}`);
  return new Uint8Array(await object.arrayBuffer());
}

beforeEach(async () => {
  valid = await readPack(
    new URL(
      '../../../../packages/template-tools/fixtures/valid/',
      import.meta.url,
    ),
  );
  platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
  create.mockClear();
  print.mockReset();
  print.mockImplementation(async job => ({
    pageCount: 1,
    pdf: new Uint8Array([37, 80, 68, 70, 45, 10]),
    gt: gtSchema.parse({ ...gtExample, source: job.source }),
  }));
}, 60_000);

afterEach(async () => {
  await platform?.dispose();
}, 30_000);

test('uploaded v1 and v2 batches reach the queue printer with their own text even when v1 runs after v2 is uploaded', async () => {
  const first = await upload(pack('第一版月報'));
  const started = await request(
    '/api/batches',
    JSON.stringify(input(first.id, first.version)),
  );
  expect(started.status).toBe(201);
  const batch1 = batchSchema.parse(await started.json());
  const second = await upload(pack('第二版月報', false));
  const response2 = await request(
    '/api/batches',
    JSON.stringify(input(second.id, second.version)),
  );
  expect(response2.status).toBe(201);
  const batch2 = batchSchema.parse(await response2.json());
  expect([batch1.templateVersion, batch2.templateVersion]).toEqual([1, 2]);

  for (const [batch, heading, other, orientation] of [
    [batch1, '第一版月報', '第二版月報', 'portrait'],
    [batch2, '第二版月報', '第一版月報', 'landscape'],
  ] as const) {
    const job: FixtureJob = {
      batchId: batch.id,
      templateId: batch.templateId,
      templateVersion: batch.templateVersion,
      seed: batch.seed,
      index: 0,
    };
    const message = {
      id: batch.id,
      timestamp: new Date(),
      attempts: 1,
      body: job,
      ack: vi.fn(),
      retry: vi.fn(),
    } satisfies Message<FixtureJob>;
    await handleFixtureMessages([message], {
      db: db(),
      files: platform.env.FILES,
      templates: templateStore(db(), platform.env.FILES),
      printer: { print },
      workflow: { get: async () => ({ sendEvent: async () => {} }) },
      checker: {
        check: async () => ({ ok: true, differences: [] }),
      },
    });
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    const printed = print.mock.calls.at(-1)?.[0];
    expect(printed?.html).toContain(`<h1 data-gt="title">${heading}</h1>`);
    expect(printed?.html).not.toContain(other);
    expect(printed?.page.orientation).toBe(orientation);
    expect(printed?.source.templateVersion).toBe(batch.templateVersion);
    const status = await request(`/api/batches/${batch.id}/fixtures`);
    expect(fixtureListSchema.parse(await status.json()).fixtures).toEqual([
      {
        index: 0,
        status: 'completed',
        check: { passed: true, differences: 0 },
      },
    ]);
    expect(await stored(job, 'fixture.pdf')).toEqual(
      new Uint8Array([37, 80, 68, 70, 45, 10]),
    );
  }
  expect(print).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(2);
});

test('an empty catalog cannot start the old bundled fixture-report and an uploaded id cannot start an absent version', async () => {
  const bundled = await request(
    '/api/batches',
    JSON.stringify(input('fixture-report', 1)),
  );
  expect(bundled.status).toBe(404);
  expect(apiErrorSchema.parse(await bundled.json()).error.code).toBe(
    'template_not_found',
  );
  const uploaded = await upload(pack('僅有第一版'));
  const missing = await request(
    '/api/batches',
    JSON.stringify(input(uploaded.id, 2)),
  );
  expect(missing.status).toBe(404);
  expect(apiErrorSchema.parse(await missing.json()).error.code).toBe(
    'template_not_found',
  );
  expect(create).not.toHaveBeenCalled();
  expect(await db().select().from(schema.batches)).toEqual([]);
});

test('the uploaded source decodes every manifest-selected file in order and preserves both versions including their samples', async () => {
  const v1 = pack('舊版');
  const v2 = pack('新版', false);
  const first = await upload(v1);
  const source = templateStore(db(), platform.env.FILES);
  expect(await source.get(first.id, 1)).toEqual(v1.decoded);
  await upload(v2);
  expect(await source.get(first.id, 2)).toEqual(v2.decoded);
  expect(await source.get(first.id, 1)).toEqual(v1.decoded);
  expect(await source.get(first.id, 3)).toBeUndefined();
  expect(await source.get('never-uploaded', 1)).toBeUndefined();
  expect(await source.get('fixture-report', 1)).toBeUndefined();
});

test.each([true, false])(
  'fixture rendering expands each/if/number for approved=%s from generated data and repeats identical HTML/data bytes',
  async approved => {
    // Isolate filling from store lookup so a missing store cannot mask the fill stub.
    const value: TemplatePack = pack('完整樣板', approved).decoded;
    const job: FixtureJob = {
      batchId: 'render',
      templateId: value.manifest.id,
      templateVersion: 1,
      seed: 'T15_fill',
      index: 0,
    };
    const deps = {
      templates: { get: async () => value },
      printer: { print },
      files: platform.env.FILES,
      // makeFixture checks the printed PDF. This test only covers filling.
      checker: {
        check: async () => ({ ok: true, differences: [] }),
      },
    };
    await makeFixture(job, deps);
    const first = print.mock.calls[0]?.[0];
    expect(first?.html).toContain('營收：1,234,567 元');
    expect(
      first?.html.match(/<tr><td>版本支出<\/td><td>2,345<\/td><\/tr>/g),
    ).toHaveLength(2);
    expect(first?.html).toContain(approved ? '>已核准</p>' : '>待核准</p>');
    expect(first?.html).not.toContain(approved ? '>待核准</p>' : '>已核准</p>');
    expect(first?.html).not.toContain('{{');
    const head =
      /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(first?.html ?? '')?.[1] ?? '';
    expect(
      [...head.matchAll(/<style\b[^>]*>\s*([\s\S]*?)<\/style>/gi)].map(match =>
        match[1]?.trim(),
      ),
    ).toEqual(value.styles.map(css => css.trim()));
    expect(first?.page).toEqual(value.manifest.page);
    const bytes = await stored(job);
    const record = JSON.parse(strFromU8(bytes));
    expect(record).toMatchObject({
      revenue: 1234567,
      approved,
      rows: [
        { item: '版本支出', amount: 2345 },
        { item: '版本支出', amount: 2345 },
      ],
    });
    expect(record.company).not.toBe('完整樣板範例有限公司');
    await makeFixture(job, deps);
    expect(print.mock.calls[1]?.[0]).toEqual(first);
    expect(await stored(job)).toEqual(bytes);
  },
);
