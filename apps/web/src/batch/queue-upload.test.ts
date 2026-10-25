import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  batchSchema,
  gtSchema,
  manifestSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import * as schema from '../db/schema.ts';
import { templates } from '../db/schema.ts';
import { createFetchHandler } from '../worker.ts';
import type { FixtureJob } from './fixture.ts';
import { consumeFixtures } from './queue.ts';

type Files = Record<string, Uint8Array>;
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let valid: Files;
const local = createLocalAccess();
const handle = createFetchHandler({
  pages: async () => new Response('Unexpected page handler', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});

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

function request(path: string, body?: Uint8Array) {
  return handle(
    new Request(new URL(path, 'https://web.example.test'), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
        ...(body === undefined ? {} : { 'content-type': 'application/zip' }),
      },
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    }),
    platform.env,
  );
}

beforeAll(async () => {
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
  await migrate(drizzle(platform.env.DB), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
}, 60_000);

beforeEach(async () => {
  await drizzle(platform.env.DB).delete(templates);
  let cursor: string | undefined;
  do {
    const page = await platform.env.FILES.list({ cursor });
    if (page.objects.length)
      await platform.env.FILES.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
});

afterAll(async () => {
  await platform?.dispose();
}, 60_000);

test('the real queue handler prints the uploaded version from R2 rather than the in-memory fixture', async () => {
  const marker = 'uploaded-version-only-T15-1';
  const files = { ...valid };
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)),
  );
  manifest.id = 'uploaded-queue-pack';
  const templatePath = manifest.files.template;
  files[templatePath] = strToU8(
    strFromU8(files[templatePath] as Uint8Array).replace('公司月報', marker),
  );
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const upload = await request('/api/templates', zipSync(files));
  expect(upload.status, await upload.clone().text()).toBe(201);
  const summary = templateSummarySchema.parse(await upload.json());
  // A later version must not replace the batch's selected version.
  files[templatePath] = strToU8(
    strFromU8(files[templatePath] as Uint8Array).replace(
      marker,
      'later-version',
    ),
  );
  expect((await request('/api/templates', zipSync(files))).status).toBe(201);
  const input = {
    templateId: summary.id,
    templateVersion: summary.version,
    seed: 'uploaded-queue',
    count: 1,
  };
  const started = await handle(
    new Request('https://web.example.test/api/batches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
      },
      body: JSON.stringify(input),
    }),
    {
      ...platform.env,
      BATCH_WORKFLOW: {
        create: async ({
          id,
        }: {
          id: string;
          params: { batchId: string };
        }) => ({ id }),
      } as unknown as Env['BATCH_WORKFLOW'],
    },
  );
  expect(started.status, await started.clone().text()).toBe(201);
  const batch = batchSchema.parse(await started.json());
  const body: FixtureJob = {
    batchId: batch.id,
    index: 0,
    templateId: summary.id,
    templateVersion: summary.version,
    seed: input.seed,
  };
  const msg = {
    id: 'uploaded-fixture',
    timestamp: new Date(),
    attempts: 3,
    body,
    ack: vi.fn(),
    retry: vi.fn<(options?: { delaySeconds?: number }) => void>(),
  } satisfies Message<FixtureJob>;
  const sent: {
    html: string;
    pack: { template: string; files: Record<string, string> };
  }[] = [];
  const sendEvent = vi.fn(
    async (_event: { type: string; payload?: unknown }) => {},
  );
  const print: Pick<Env['PRINT'], 'fetch'> = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      sent.push((await req.json()) as (typeof sent)[number]);
      return Response.json({
        pageCount: 2,
        pdf: 'AQIDBA==',
        gt: gtSchema.parse({
          ...gtExample,
          source: {
            templateId: summary.id,
            templateVersion: summary.version,
            seed: body.seed,
            index: 0,
          },
        }),
      });
    },
  };
  await consumeFixtures(
    { messages: [msg] } as unknown as MessageBatch<FixtureJob>,
    {
      ...platform.env,
      PRINT_TOKEN: 'uploaded-queue-test',
      PRINT: print as Env['PRINT'],
      BATCH_WORKFLOW: {
        get: async () => ({ sendEvent }),
      } as unknown as Env['BATCH_WORKFLOW'],
    },
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.html).toContain(marker);
  expect(sent[0]?.html).not.toContain('later-version');
  expect(sent[0]?.pack.template).toBe(templatePath);
  for (const [path, bytes] of Object.entries(valid)) {
    if (path === 'manifest.json' || path === templatePath) continue;
    expect(sent[0]?.pack.files[path], path).toBe(
      Buffer.from(bytes).toString('base64'),
    );
  }
  expect(
    Buffer.from(sent[0]?.pack.files[templatePath] ?? '', 'base64').toString(),
  ).toContain(marker);
  const rows = await drizzle(platform.env.DB)
    .select()
    .from(schema.fixtures)
    .where(eq(schema.fixtures.batchId, batch.id));
  // Deliberately unreadable bytes exercise the real checker cheaply, without
  // browser rendering or a self-check mock that could hide a wiring regression.
  expect(rows).toEqual([
    expect.objectContaining({
      index: 0,
      status: 'failed',
      attempts: 3,
      error: expect.stringContaining('Invalid PDF'),
    }),
  ]);
  expect(msg.ack).toHaveBeenCalledTimes(1);
  expect(msg.retry).not.toHaveBeenCalled();
  expect(sendEvent).toHaveBeenCalledWith({ type: 'fixtures-done' });
});
