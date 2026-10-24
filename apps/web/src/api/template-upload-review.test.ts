import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import {
  apiErrorSchema,
  manifestSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
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

function bytes(files: Files, path: string): Uint8Array {
  const value = files[path];
  if (value === undefined) throw new Error(`Missing fixture: ${path}`);
  return value;
}

function addAsset(files: Files, path: string, content: Uint8Array) {
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(bytes(files, 'manifest.json'))),
  );
  manifest.files.assets = [...(manifest.files.assets ?? []), path];
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  files[path] = content;
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

// A 1x1 PNG with a valid ancillary tEXt chunk, exceeding both text budgets.
function largePng(): Uint8Array {
  const png = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const data = strToU8(`Comment\0${'x'.repeat(300 * 1024)}`);
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(strToU8('tEXt'), 4);
  chunk.set(data, 8);
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));
  const result = new Uint8Array(png.length + chunk.length);
  result.set(png.subarray(0, -12));
  result.set(chunk, png.length - 12);
  result.set(png.subarray(-12), png.length - 12 + chunk.length);
  return result;
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

afterAll(async () => {
  await platform?.dispose();
}, 30_000);

test('keeps a legitimate referenced PNG above the text budgets uploadable and byte-identical on download', async () => {
  const files = { ...valid };
  const png = largePng();
  addAsset(files, 'assets/photo.png', png);
  files['templates/report.hbs'] = strToU8(
    strFromU8(bytes(files, 'templates/report.hbs')).replace(
      '</body>',
      '<img data-gt="image" src="../assets/photo.png" alt="fixture"></body>',
    ),
  );
  const zip = zipSync(files);
  const uploaded = await request('/api/templates', zip);
  expect(uploaded.status).toBe(201);
  const summary = templateSummarySchema.parse(await uploaded.json());
  const downloaded = await request(
    `/api/templates/${summary.id}/versions/${summary.version}/pack.zip`,
  );
  expect(downloaded.status).toBe(200);
  const stored = new Uint8Array(await downloaded.arrayBuffer());
  expect(stored).toEqual(zip);
  expect(unzipSync(stored)['assets/photo.png']).toEqual(png);
});

test.each(['@import', '<link>'])(
  'answers promptly when %s parses a binary-named asset as oversized CSS',
  async reference => {
    const files = { ...valid };
    addAsset(
      files,
      'assets/slow.png',
      strToU8('@font-face{'.repeat(Math.ceil((1024 * 1024) / 11))),
    );
    if (reference === '@import') {
      files['styles/report.css'] = strToU8(
        `@import url(../assets/slow.png);\n${strFromU8(bytes(files, 'styles/report.css'))}`,
      );
    } else {
      files['templates/report.hbs'] = strToU8(
        strFromU8(bytes(files, 'templates/report.hbs')).replace(
          '</head>',
          '<link rel="stylesheet" href="../assets/slow.png"></head>',
        ),
      );
    }
    const zip = zipSync(files);
    const start = performance.now();
    const response = await request('/api/templates', zip);
    await response.arrayBuffer();
    // checkPack runs synchronously: also catch blocked event-loop time, when
    // Vitest's timeout callback cannot fire until parsing has returned.
    expect(performance.now() - start).toBeLessThan(5_000);
    expect([201, 400]).toContain(response.status);
  },
);

test.each(['../outside.txt', '/abs.txt'])(
  'keeps path-invalid for %s within the API error contract without losing its offending path',
  async invalidPath => {
    const files = { ...valid, [invalidPath]: strToU8('outside') };
    files['data/sample.json'] = strToU8('{');
    // A flat file map preserves the literal name rather than constructing
    // nested zip directories that could normalize traversal segments away.
    const zip = zipSync(files);
    expect(Object.keys(unzipSync(zip))).toContain(invalidPath);
    expect(unzipSync(zip)[invalidPath]).toEqual(strToU8('outside'));

    const response = await request('/api/templates', zip);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'invalid_template_pack' } });
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
    const error = apiErrorSchema.parse(body).error;
    const detail = error.details?.find(item =>
      item.message.startsWith('path-invalid: '),
    );
    expect(detail).toBeDefined();
    expect(detail?.message).toContain(invalidPath);
    expect(detail).not.toHaveProperty('file');
    expect(error.details).toContainEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^json-syntax: /),
        file: 'data/sample.json',
      }),
    );
  },
);
