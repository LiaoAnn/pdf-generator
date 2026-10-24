import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  apiErrorSchema,
  manifestSchema,
  templateListSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, unzipSync } from 'fflate';
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

const MiB = 1024 * 1024;
// Enough entries that walking them costs seconds, yet the zip stays under the
// 10 MiB body limit (about 35 bytes per unlisted entry, 85 per listed one).
const manyFiles = 180_000;
const manyDirectories = 250_000;
const manyListed = 115_000;

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

/** One zip entry as stored in the zip: deflated when non-empty. */
type Part = { name: string; stream: Uint8Array; method: 0 | 8; crc: number };

function part(name: string, data: Uint8Array = new Uint8Array()): Part {
  const method = data.byteLength === 0 ? 0 : 8;
  return {
    name,
    stream: method === 0 ? data : new Uint8Array(deflateRawSync(data)),
    method,
    crc: crc32(data),
  };
}

function entryNames(count: number, suffix: string): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${i.toString(36).padStart(4, '0')}${suffix}`,
  );
}

function localHeader(entry: Part, size: number): Uint8Array {
  const name = strToU8(entry.name);
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(12, 0x21, true); // 1980-01-01
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.stream.byteLength, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  header.set(name, 30);
  return header;
}

function centralEntry(entry: Part, size: number, offset: number): Uint8Array {
  const name = strToU8(entry.name);
  const header = new Uint8Array(46 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.stream.byteLength, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  header.set(name, 46);
  return header;
}

/**
 * A zip assembled by hand. `listed` entries have a local header and a central
 * directory entry (`data` gives their real sizes); `unlisted` entries have a
 * local header only, between the last listed entry and the central directory.
 * Past 65,535 listed entries the end record is written in zip64.
 */
function assemble(
  listed: Part[],
  sizes: Map<string, number>,
  unlisted: Part[] = [],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.byteLength;
  };
  for (const entry of listed) {
    const size = sizes.get(entry.name) ?? 0;
    central.push(centralEntry(entry, size, offset));
    push(localHeader(entry, size));
    push(entry.stream);
  }
  for (const entry of unlisted) {
    push(localHeader(entry, 0));
    push(entry.stream);
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.byteLength, 0);
  const centralOffset = offset;
  const count = listed.length;
  const tail: Uint8Array[] = [];
  if (count >= 0xffff) {
    const record = new Uint8Array(56);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x06064b50, true);
    recordView.setBigUint64(4, 44n, true);
    recordView.setUint16(12, 45, true);
    recordView.setUint16(14, 45, true);
    recordView.setBigUint64(24, BigInt(count), true);
    recordView.setBigUint64(32, BigInt(count), true);
    recordView.setBigUint64(40, BigInt(centralSize), true);
    recordView.setBigUint64(48, BigInt(centralOffset), true);
    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, 0x07064b50, true);
    locatorView.setBigUint64(8, BigInt(centralOffset + centralSize), true);
    locatorView.setUint32(16, 1, true);
    tail.push(record, locator);
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, Math.min(count, 0xffff), true);
  endView.setUint16(10, Math.min(count, 0xffff), true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return new Uint8Array(Buffer.concat([...chunks, ...central, ...tail, end]));
}

/** The valid fixture's files, each listed with its true size. */
function validParts(files: Files = valid): {
  parts: Part[];
  sizes: Map<string, number>;
} {
  const parts = Object.entries(files).map(([path, data]) => part(path, data));
  const sizes = new Map(
    Object.entries(files).map(([path, data]) => [path, data.byteLength]),
  );
  return { parts, sizes };
}

async function listed() {
  const response = await request('/api/templates');
  expect(response.status).toBe(200);
  return templateListSchema.parse(await response.json()).templates;
}

/** The upload is refused promptly as an invalid pack and nothing is stored. */
async function refused(zip: Uint8Array) {
  const start = performance.now();
  const response = await request('/api/templates', zip);
  const body = await response.json();
  // The unzip is synchronous: Vitest's timeout cannot fire until it returns,
  // so also bound the time itself.
  expect(performance.now() - start).toBeLessThan(3_000);
  expect(response.status).toBe(400);
  expect(body).toMatchObject({ error: { code: 'invalid_template_pack' } });
  apiErrorSchema.parse(body);
  expect(await listed()).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
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

test('the crafted zips are what the tests claim', () => {
  const { parts, sizes } = validParts();
  const fillers = entryNames(manyFiles, '').map(name => part(name));
  const hidden = assemble(parts, sizes, fillers);
  expect(hidden.byteLength).toBeLessThan(10 * MiB);
  // A reader that trusts the central directory sees only the pack.
  expect(Object.keys(unzipSync(hidden)).sort()).toEqual(
    Object.keys(valid).sort(),
  );

  for (const suffix of ['/', '']) {
    const many = assemble(
      [...parts, ...entryNames(manyListed, suffix).map(name => part(name))],
      sizes,
    );
    expect(many.byteLength).toBeLessThan(10 * MiB);
    let count = 0;
    unzipSync(many, {
      filter: () => {
        count++;
        return false;
      },
    });
    expect(count).toBe(parts.length + manyListed);
  }
});

test('refuses 180,000 empty local entries missing from the central directory, promptly and storing nothing', async () => {
  // Regression: walking local headers (fflate's streaming Unzip) before any
  // limit on their number is checked, so one under-10 MiB upload keeps the
  // Worker busy for ~10 s, and the entries it never listed join the pack.
  const { parts, sizes } = validParts();
  const fillers = entryNames(manyFiles, '').map(name => part(name));
  await refused(assemble(parts, sizes, fillers));
}, 60_000);

test('refuses 250,000 unlisted empty directory entries, promptly and storing nothing', async () => {
  // Regression: skipping `x/` names as directories only after the whole
  // local-header walk, so the same flood of unlisted entries is slow and the
  // pack is even accepted.
  const { parts, sizes } = validParts();
  const fillers = entryNames(manyDirectories, '/').map(name => part(name));
  await refused(assemble(parts, sizes, fillers));
}, 60_000);

test.each([
  ['directory entries', '/'],
  ['empty files', ''],
])(
  'refuses a central directory listing 115,000 %s, promptly and storing nothing',
  async (_kind, suffix) => {
    // Regression: no bound on the number of entries the central directory
    // lists, so reading, then walking, 115,000 of them takes seconds before
    // (or instead of) the 200-file limit applying.
    const { parts, sizes } = validParts();
    const many = entryNames(manyListed, suffix).map(name => part(name));
    await refused(assemble([...parts, ...many], sizes));
  },
  30_000,
);

test('refuses an empty local entry that the manifest lists but the central directory does not', async () => {
  // Regression: an entry the directory does not list being read as pack
  // content (its empty size "matches" the missing declaration, and the
  // manifest finds its file) instead of the zip being refused as
  // inconsistent.
  const files = { ...valid };
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)),
  );
  manifest.files.assets = [
    ...(manifest.files.assets ?? []),
    'assets/extra.png',
  ];
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const { parts, sizes } = validParts(files);
  await refused(assemble(parts, sizes, [part('assets/extra.png')]));
});

test('accepts the valid fixture zipped with explicit directory entries and downloads it byte-identical', async () => {
  // Regression: an entry-count or unlisted-entry check that also trips on the
  // empty directory entries `zip -r` writes for every folder.
  const { parts, sizes } = validParts();
  const folders = ['templates/', 'styles/', 'data/', 'assets/'];
  const zip = assemble([...folders.map(name => part(name)), ...parts], sizes);
  expect(Object.keys(unzipSync(zip))).toEqual(expect.arrayContaining(folders));

  const uploaded = await request('/api/templates', zip);
  expect(uploaded.status).toBe(201);
  const summary = templateSummarySchema.parse(await uploaded.json());
  const downloaded = await request(
    `/api/templates/${summary.id}/versions/${summary.version}/pack.zip`,
  );
  expect(downloaded.status).toBe(200);
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(zip);
});
