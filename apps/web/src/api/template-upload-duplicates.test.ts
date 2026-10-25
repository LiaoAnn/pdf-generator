import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { apiErrorSchema, templateListSchema } from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strToU8 } from 'fflate';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { templates } from '../db/schema.ts';
import { explainError } from '../templates/explain.ts';
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

async function duplicateRefused(zip: Uint8Array, name: string) {
  const response = await request('/api/templates', zip);
  expect(response.status).toBe(400);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.details).toContainEqual(
    expect.objectContaining({
      code: 'zip-duplicate-name',
    }),
  );
  const issue = body.error.details?.find(
    detail => detail.code === 'zip-duplicate-name',
  );
  expect([name, '.', undefined]).toContain(issue?.file);
  const listed = await request('/api/templates');
  expect(templateListSchema.parse(await listed.json()).templates).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
}

test.each([2, 65_535])(
  'refuses %i central-directory occurrences of one name before storing anything',
  async count => {
    const { parts, sizes } = validParts();
    const repeated = parts.find(entry => entry.name === 'assets/report.woff2');
    if (!repeated) throw new Error('Missing fixture font');
    // Directory references may repeat the same local record: no duplicate local
    // records are needed to expose a central-directory last-wins bug.
    const base = assemble(parts, sizes);
    const end = Buffer.from(base.subarray(-22));
    const centralOffset = end.readUInt32LE(16);
    const centralSize = end.readUInt32LE(12);
    const preceding = parts.slice(0, parts.indexOf(repeated));
    const repeatedOffset = preceding.reduce(
      (sum, entry) =>
        sum +
        localHeader(entry, sizes.get(entry.name) ?? 0).length +
        entry.stream.length,
      0,
    );
    const repeatedCentral = centralEntry(
      repeated,
      sizes.get(repeated.name) ?? 0,
      repeatedOffset,
    );
    const central = Buffer.concat([
      base.subarray(centralOffset, centralOffset + centralSize),
      ...Array.from({ length: count - 1 }, () => repeatedCentral),
    ]);
    // Use assemble's ZIP64 end records for 65,535+ directory records.
    const skeleton = assemble(
      Array.from({ length: parts.length + count - 1 }, () => repeated),
      sizes,
    );
    const tailLength = parts.length + count - 1 >= 0xffff ? 98 : 22;
    const tail = Buffer.from(skeleton.subarray(-tailLength));
    if (tailLength === 98) {
      tail.writeBigUInt64LE(BigInt(central.length), 40);
      tail.writeBigUInt64LE(BigInt(centralOffset), 48);
      tail.writeBigUInt64LE(BigInt(centralOffset + central.length), 64);
    }
    tail.writeUInt32LE(central.length, tail.length - 10);
    tail.writeUInt32LE(centralOffset, tail.length - 6);
    await duplicateRefused(
      new Uint8Array(
        Buffer.concat([base.subarray(0, centralOffset), central, tail]),
      ),
      repeated.name,
    );
  },
);

test('refuses a second local header with a listed name even when the directory names are unique', async () => {
  const { parts, sizes } = validParts();
  const name = 'assets/report.woff2';
  await duplicateRefused(assemble(parts, sizes, [part(name)]), name);
});

test('still accepts an ordinary pack with unique local and directory names', async () => {
  const { parts, sizes } = validParts();
  expect((await request('/api/templates', assemble(parts, sizes))).status).toBe(
    201,
  );
});

test('zip-duplicate-name has its own Chinese explanation', () => {
  const explanation = (code: string) =>
    explainError({
      code: 'invalid_template_pack',
      message: 'Invalid pack',
      details: [
        { code, file: 'assets/repeated.png', message: 'Repeated name' },
      ],
    }).issues[0]?.explanation;
  expect(explanation('zip-duplicate-name')).toMatch(/[\u3400-\u9fff]/);
  expect(explanation('zip-duplicate-name')).not.toBe(
    explanation('future-code'),
  );
});

test('1,001 unique entries including directories are refused as pack-too-many-files', async () => {
  const { parts, sizes } = validParts();
  const folders = Array.from({ length: 1001 - parts.length }, (_, i) =>
    part(`folder-${i}/`),
  );
  const response = await request(
    '/api/templates',
    assemble([...parts, ...folders], sizes),
  );
  expect(response.status).toBe(400);
  expect(
    apiErrorSchema.parse(await response.json()).error.details,
  ).toContainEqual(expect.objectContaining({ code: 'pack-too-many-files' }));
  expect(
    templateListSchema.parse(await (await request('/api/templates')).json())
      .templates,
  ).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
});
