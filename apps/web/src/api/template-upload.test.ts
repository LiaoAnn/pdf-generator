import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  type Manifest,
  manifestSchema,
  templateListSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, zipSync } from 'fflate';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { getPlatformProxy } from 'wrangler';
import {
  checkPack,
  type PackIssue,
} from '../../../../packages/template-tools/src/index.ts';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { templates } from '../db/schema.ts';
import { createFetchHandler } from '../worker.ts';

const fixtures = new URL(
  '../../../../packages/template-tools/fixtures/',
  import.meta.url,
);
type Files = Record<string, Uint8Array>;
function requiredBytes(value: Uint8Array | undefined): Uint8Array {
  if (value === undefined) throw new Error('Test fixture bytes are missing');
  return value;
}
type LocalPlatform = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let platform: LocalPlatform;
let valid: Files;
let originalManifest: Manifest;
const local = createLocalAccess();
const handle = createFetchHandler({
  pages: async () =>
    new Response('API request reached the page handler', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});

async function readPack(root: URL, prefix = ''): Promise<Files> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Files = {};
  for (const entry of entries) {
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

function request(
  path: string,
  body?: Uint8Array,
  extraHeaders: Record<string, string> = {},
) {
  return handle(
    new Request(new URL(path, 'https://web.example.test'), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
        ...(body === undefined ? {} : { 'content-type': 'application/zip' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    }),
    platform.env,
  );
}

function pack(change: Partial<Manifest> = {}): Files {
  return {
    ...valid,
    'manifest.json': strToU8(
      JSON.stringify({ ...originalManifest, ...change }),
    ),
  };
}

function addAssets(files: Files, assets: Files) {
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(requiredBytes(files['manifest.json']))),
  );
  manifest.files.assets = [
    ...(manifest.files.assets ?? []),
    ...Object.keys(assets),
  ];
  Object.assign(files, assets, {
    'manifest.json': strToU8(JSON.stringify(manifest)),
  });
}

async function upload(bytes: Uint8Array) {
  const response = await request('/api/templates', bytes);
  expect(response.status).toBe(201);
  return templateSummarySchema.parse(await response.json());
}

async function list(path = '/api/templates') {
  const response = await request(path);
  expect(response.status).toBe(200);
  return templateListSchema.parse(await response.json()).templates;
}

async function download(id: string, version: number, bytes: Uint8Array) {
  const response = await request(
    `/api/templates/${id}/versions/${version}/pack.zip`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/zip\b/i);
  expect(response.headers.get('content-disposition')).toMatch(
    new RegExp(
      `^attachment;\\s*filename="?${id}-v${version}\\.zip"?(?:;|$)`,
      'i',
    ),
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
}

async function refused(
  bytes: Uint8Array,
  status = 400,
  code = 'invalid_template_pack',
  headers: Record<string, string> = {},
) {
  const response = await request('/api/templates', bytes, headers);
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message.trim().length).toBeGreaterThan(0);
  expect(await list()).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
  return body.error;
}

function detail({ code, message, file, ...location }: PackIssue) {
  return {
    message: `${code}: ${message}`,
    ...(file === '.' ? {} : { file }),
    ...location,
  };
}

beforeAll(async () => {
  valid = await readPack(new URL('valid/', fixtures));
  originalManifest = manifestSchema.parse(
    JSON.parse(strFromU8(requiredBytes(valid['manifest.json']))),
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
  // This proxy is ephemeral and belongs only to this test file.
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
}, 30_000);

describe('template upload HTTP acceptance with local D1 and R2', () => {
  test('re-uploading identical bytes adds versions and later changes preserve the original download', async () => {
    const bytes = zipSync(valid);
    const first = await upload(bytes);
    const second = await upload(bytes);
    expect(first).toEqual({
      id: originalManifest.id,
      version: 1,
      name: originalManifest.name,
      page: originalManifest.page,
      createdAt: expect.any(String),
    });
    expect(second).toEqual({
      ...first,
      version: 2,
      createdAt: expect.any(String),
    });
    const changedBytes = zipSync(
      pack({
        description: '第二次修改，保留舊版',
        page: { size: 'A4', orientation: 'landscape' },
      }),
    );
    const third = await upload(changedBytes);
    expect(third).toEqual({
      ...first,
      version: 3,
      description: '第二次修改，保留舊版',
      page: { size: 'A4', orientation: 'landscape' },
      createdAt: expect.any(String),
    });
    expect(await list()).toEqual([first, second, third]);
    expect(await list(`/api/templates/${first.id}`)).toEqual([
      first,
      second,
      third,
    ]);
    await download(first.id, 1, bytes);
    await download(second.id, 2, bytes);
    await download(third.id, 3, changedBytes);
  });

  test('different ids start at version one and id-specific lists exclude other templates', async () => {
    const z = await upload(zipSync(pack({ id: 'z-report', description: '' })));
    const a = await upload(zipSync(pack({ id: 'a-report' })));
    const z2 = await upload(
      zipSync(pack({ id: 'z-report', description: '新版' })),
    );
    expect([z.version, a.version, z2.version]).toEqual([1, 1, 2]);
    expect(z.description).toBe('');
    expect(await list()).toEqual([a, z, z2]);
    expect(await list('/api/templates/z-report')).toEqual([z, z2]);
  });

  test('parallel uploads allocate distinct consecutive versions and keep each version paired with its own bytes', async () => {
    const archives = [1, 2, 3].map(n =>
      zipSync(pack({ description: `並行上傳 ${n}` })),
    );
    const summaries = await Promise.all(archives.map(upload));
    expect(
      summaries.map(summary => summary.version).sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    expect(await list(`/api/templates/${originalManifest.id}`)).toEqual(
      [...summaries].sort((a, b) => a.version - b.version),
    );
    for (const [index, summary] of summaries.entries()) {
      expect(summary.description).toBe(`並行上傳 ${index + 1}`);
      await download(
        summary.id,
        summary.version,
        requiredBytes(archives[index]),
      );
    }
  });

  test.each([
    '01-missing-stylesheet',
    '02-invalid-orientation',
    '03-inverted-money-range',
    '04-national-id-check-digit',
    '05-trailing-comma',
    '06-field-typo',
    '07-unmarked-else',
    '08-unknown-block-type',
    '09-nested-mark',
    '10-missing-font-url',
  ])(
    'refuses broken fixture %s with every checkPack message and exact source location, without storage',
    async name => {
      const root = new URL(`broken/${name}/`, fixtures);
      const bytes = zipSync(await readPack(new URL('pack/', root)));
      const expected = JSON.parse(
        await readFile(new URL('expected.json', root), 'utf8'),
      ) as { issues: Omit<PackIssue, 'message'>[] };
      const checked = checkPack(bytes);
      expect(checked.ok).toBe(false);
      expect(
        checked.issues.map(({ message: _message, ...issue }) => issue),
      ).toEqual(expected.issues);
      const error = await refused(bytes);
      expect(error.details).toEqual(checked.issues.map(detail));
    },
  );

  test('returns every issue rather than only the first when a pack has multiple errors', async () => {
    const files = pack();
    delete files['styles/report.css'];
    delete files['assets/report.woff2'];
    const bytes = zipSync(files);
    const checked = checkPack(bytes);
    expect(checked.issues.length).toBeGreaterThan(1);
    const error = await refused(bytes);
    expect(error.details).toEqual(checked.issues.map(detail));
  });

  test('non-zip input returns zip-invalid and omits the whole-pack dot filename', async () => {
    const bytes = strToU8('this is not a zip');
    const error = await refused(bytes);
    expect(error.details).toEqual(checkPack(bytes).issues.map(detail));
    expect(error.details).toEqual([
      { message: expect.stringMatching(/^zip-invalid: /) },
    ]);
  });

  test.each([false, true])(
    'rejects more than 10 MiB before attempting zip validation (Content-Length present: %s)',
    async withLength => {
      const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
      await refused(
        bytes,
        413,
        'template_pack_too_large',
        withLength ? { 'content-length': String(bytes.length) } : {},
      );
    },
  );

  test('refuses a compressed text file over 64 KiB with its path before parsing malformed CSS', async () => {
    const files = pack();
    files['styles/report.css'] = strToU8('('.repeat(65_537));
    const error = await refused(zipSync(files));
    expect(error.details).toContainEqual({
      file: 'styles/report.css',
      message: expect.stringMatching(/^file-too-large: /),
    });
  });

  test('counts UTF-8 bytes rather than characters for the per-file text limit', async () => {
    const files = pack();
    files['styles/report.css'] = strToU8(`/*${'月'.repeat(22_000)}*/`);
    const error = await refused(zipSync(files));
    expect(error.details).toContainEqual({
      file: 'styles/report.css',
      message: expect.stringMatching(/^file-too-large: /),
    });
  });

  test.each(['hbs', 'css', 'json', 'svg', 'txt'])(
    'applies the text limit to .%s files even when listed as assets',
    async extension => {
      const files = pack();
      const path = `assets/oversized.${extension}`;
      addAssets(files, { [path]: new Uint8Array(65_537).fill(32) });
      const error = await refused(zipSync(files));
      expect(error.details).toContainEqual({
        file: path,
        message: expect.stringMatching(/^file-too-large: /),
      });
    },
  );

  test('allows exactly 64 KiB of valid CSS', async () => {
    const files = pack();
    const css = requiredBytes(files['styles/report.css']);
    const padded = new Uint8Array(65_536).fill(32);
    padded.set(css);
    files['styles/report.css'] = padded;
    const bytes = zipSync(files);
    expect(checkPack(bytes).ok).toBe(true);
    const summary = await upload(bytes);
    await download(summary.id, summary.version, bytes);
  });

  test('rejects 201 files before semantic validation but accepts exactly 200', async () => {
    const files = pack();
    const additions = Object.fromEntries(
      Array.from({ length: 200 - Object.keys(files).length }, (_, i) => [
        `assets/extra-${i}.png`,
        new Uint8Array(),
      ]),
    );
    addAssets(files, additions);
    const boundaryBytes = zipSync(files);
    expect(checkPack(boundaryBytes).ok).toBe(true);
    const tooMany = { ...files, 'assets/one-too-many.png': new Uint8Array() };
    const error = await refused(zipSync(tooMany));
    expect(error.details).toContainEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^pack-too-many-files: /),
      }),
    );
    await upload(boundaryBytes);
  });

  test('counts all text files toward 256 KiB, accepts equality, and rejects one extra byte', async () => {
    const files = pack();
    const assets = Object.fromEntries(
      [0, 1, 2, 3].map(i => [`assets/padding-${i}.txt`, new Uint8Array()]),
    );
    addAssets(files, assets);
    const baseSize = Object.entries(files).reduce(
      (sum, [path, bytes]) =>
        sum +
        (/\.(png|jpg|jpeg|gif|webp|woff|woff2|ttf|otf)$/i.test(path)
          ? 0
          : bytes.length),
      0,
    );
    let remaining = 262_144 - baseSize;
    for (const path of Object.keys(assets)) {
      const size = Math.min(65_536, remaining);
      files[path] = new Uint8Array(size).fill(32);
      remaining -= size;
    }
    expect(remaining).toBe(0);
    const boundaryBytes = zipSync(files);
    expect(checkPack(boundaryBytes).ok).toBe(true);
    const last = 'assets/padding-3.txt';
    const oversized = {
      ...files,
      [last]: new Uint8Array(requiredBytes(files[last]).length + 1).fill(32),
    };
    expect(oversized[last].length).toBeLessThanOrEqual(65_536);
    const error = await refused(zipSync(oversized));
    expect(error.details).toContainEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^pack-text-too-large: /),
      }),
    );
    await upload(boundaryBytes);
  });

  test('exempts all binary extensions case-insensitively from per-file and combined text limits', async () => {
    const files = pack();
    addAssets(
      files,
      Object.fromEntries(
        [
          'png',
          'JPG',
          'jpeg',
          'GIF',
          'webp',
          'WOFF',
          'woff2',
          'TTF',
          'otf',
        ].map(extension => [
          `assets/large.${extension}`,
          new Uint8Array(65_537).fill(255),
        ]),
      ),
    );
    const bytes = zipSync(files);
    expect(checkPack(bytes).ok).toBe(true);
    const summary = await upload(bytes);
    await download(summary.id, summary.version, bytes);
  });

  test.each([
    '/api/templates/unknown-report',
    '/api/templates/unknown-report/versions/1/pack.zip',
    '/api/templates/unknown-report/versions/abc/pack.zip',
  ])('returns template_not_found for missing resource %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      'template_not_found',
    );
  });

  test.each(['2', 'abc', '1.5', '0', '-1'])(
    'does not serve an existing pack for unknown or invalid version %s',
    async version => {
      const summary = await upload(zipSync(valid));
      const response = await request(
        `/api/templates/${summary.id}/versions/${version}/pack.zip`,
      );
      expect(response.status).toBe(404);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
        'template_not_found',
      );
    },
  );
});
