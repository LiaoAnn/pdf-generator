import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  manifestSchema,
  templateListSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { templates } from '../db/schema.ts';
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

function totalPack(extra: number): Files {
  const files = { ...valid };
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)),
  );
  manifest.files.assets = [
    ...(manifest.files.assets ?? []),
    'assets/padding-a.png',
    'assets/padding-b.png',
  ];
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const used = Object.values(files).reduce(
    (sum, bytes) => sum + bytes.length,
    0,
  );
  const padding = 20 * 1024 * 1024 + extra - used;
  files['assets/padding-a.png'] = new Uint8Array(10 * 1024 * 1024);
  files['assets/padding-b.png'] = new Uint8Array(padding - 10 * 1024 * 1024);
  expect(
    Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
  ).toBe(20 * 1024 * 1024 + extra);
  return files;
}
test('accepts exactly 20 MiB uncompressed including binary assets', async () => {
  const bytes = zipSync(totalPack(0));
  expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
  const response = await request('/api/templates', bytes);
  expect(response.status, await response.clone().text()).toBe(201);
  const summary = templateSummarySchema.parse(await response.json());
  const downloaded = await request(
    '/api/templates/' +
      summary.id +
      '/versions/' +
      summary.version +
      '/pack.zip',
  );
  expect(downloaded.status).toBe(200);
  expect(
    createHash('sha256')
      .update(new Uint8Array(await downloaded.arrayBuffer()))
      .digest('hex'),
  ).toBe(createHash('sha256').update(bytes).digest('hex'));
});
test('refuses 20 MiB plus one byte as pack-too-large and stores nothing', async () => {
  const bytes = zipSync(totalPack(1));
  expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
  const response = await request('/api/templates', bytes);
  expect(response.status).toBe(400);
  expect(
    apiErrorSchema.parse(await response.json()).error.details,
  ).toContainEqual(expect.objectContaining({ code: 'pack-too-large' }));
  expect(
    templateListSchema.parse(await (await request('/api/templates')).json())
      .templates,
  ).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
});
