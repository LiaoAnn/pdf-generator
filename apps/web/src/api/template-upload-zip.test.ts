import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  crc32,
  createDeflateRaw,
  deflateRawSync,
  inflateRawSync,
} from 'node:zlib';
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

function listAsset(files: Files, path: string) {
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(bytes(files, 'manifest.json'))),
  );
  manifest.files.assets = [...(manifest.files.assets ?? []), path];
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
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

/**
 * One zip entry, assembled by hand: `stream` is the entry's data as stored in
 * the zip (raw deflate for method 8), `declaredSize` is the uncompressed size
 * written to the headers, whatever the stream really inflates to.
 */
type Part = {
  name: string;
  method: 0 | 8;
  stream: Uint8Array;
  crc: number;
  declaredSize: number;
  /** Sizes and CRC come after the data (flag bit 3), as in streamed zips. */
  descriptor?: boolean;
};

function honestPart(
  name: string,
  data: Uint8Array,
  options: { method?: 0 | 8; descriptor?: boolean } = {},
): Part {
  const method = options.method ?? 8;
  return {
    name,
    method,
    stream: method === 0 ? data : new Uint8Array(deflateRawSync(data)),
    crc: crc32(data),
    declaredSize: data.byteLength,
    descriptor: options.descriptor ?? false,
  };
}

function assemble(parts: Part[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.byteLength;
  };
  for (const part of parts) {
    const name = strToU8(part.name);
    const flags = (part.descriptor ? 0x0008 : 0) | 0x0800;
    const sizes = (view: DataView, at: number, zeroed: boolean) => {
      view.setUint32(at, zeroed ? 0 : part.crc, true);
      view.setUint32(at + 4, zeroed ? 0 : part.stream.byteLength, true);
      view.setUint32(at + 8, zeroed ? 0 : part.declaredSize, true);
    };
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, part.method, true);
    localView.setUint16(12, 0x21, true); // 1980-01-01
    sizes(localView, 14, part.descriptor === true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, flags, true);
    entryView.setUint16(10, part.method, true);
    entryView.setUint16(14, 0x21, true);
    sizes(entryView, 16, false);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    push(local);
    push(part.stream);
    if (part.descriptor) {
      const tail = new Uint8Array(16);
      const tailView = new DataView(tail.buffer);
      tailView.setUint32(0, 0x08074b50, true);
      sizes(tailView, 4, false);
      push(tail);
    }
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, parts.length, true);
  endView.setUint16(10, parts.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

function honestParts(
  files: Files,
  options: (path: string) => {
    method?: 0 | 8;
    descriptor?: boolean;
  } = () => ({}),
): Part[] {
  return Object.entries(files).map(([path, data]) =>
    honestPart(path, data, options(path)),
  );
}

/**
 * A raw-deflate stream that inflates to `size` zero bytes (a multiple of
 * MiB), fed to zlib one reused 1 MiB buffer at a time so no big buffer is held.
 */
async function zerosStream(size: number): Promise<Uint8Array> {
  const deflate = createDeflateRaw({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>(resolve => deflate.on('end', resolve));
  const zeros = new Uint8Array(MiB);
  for (let written = 0; written < size; written += MiB) {
    if (!deflate.write(zeros)) await once(deflate, 'drain');
  }
  deflate.end();
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}

/** An entry that declares 10 zero bytes but carries `size` bytes of zeros. */
async function understated(name: string, size: number): Promise<Part> {
  return {
    name,
    method: 8,
    stream: await zerosStream(size),
    crc: crc32(new Uint8Array(10)),
    declaredSize: 10,
  };
}

/** Header fields of the first entry: local, then central directory. */
function firstEntry(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const central = view.getUint32(end + 16, true);
  return {
    flags: view.getUint16(6, true),
    method: view.getUint16(8, true),
    localCompressed: view.getUint32(18, true),
    localSize: view.getUint32(22, true),
    centralCompressed: view.getUint32(central + 20, true),
    centralSize: view.getUint32(central + 24, true),
  };
}

async function listed() {
  const response = await request('/api/templates');
  expect(response.status).toBe(200);
  return templateListSchema.parse(await response.json()).templates;
}

/** The upload is refused as an invalid pack and nothing is stored. */
async function refused(zip: Uint8Array) {
  const start = performance.now();
  const response = await request('/api/templates', zip);
  const body = await response.json();
  // The unzip is synchronous: Vitest's timeout cannot fire until it returns,
  // so also bound the time itself.
  expect(performance.now() - start).toBeLessThan(3_000);
  expect(response.status).toBe(400);
  expect(body).toMatchObject({ error: { code: 'invalid_template_pack' } });
  const error = apiErrorSchema.parse(body).error;
  expect(error.details?.length).toBeGreaterThan(0);
  for (const detail of error.details ?? []) {
    expect(detail.code).toEqual(expect.any(String));
    expect(detail.message).not.toMatch(/^[a-z][a-z0-9_-]*: /);
  }
  expect(await listed()).toEqual([]);
  expect((await platform.env.FILES.list()).objects).toEqual([]);
  return error;
}

function names(error: { details?: { message: string; file?: string }[] }) {
  return JSON.stringify(error.details ?? []);
}

async function acceptedAndDownloaded(zip: Uint8Array) {
  const uploaded = await request('/api/templates', zip);
  expect(uploaded.status).toBe(201);
  const summary = templateSummarySchema.parse(await uploaded.json());
  const downloaded = await request(
    `/api/templates/${summary.id}/versions/${summary.version}/pack.zip`,
  );
  expect(downloaded.status).toBe(200);
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(zip);
}

// The bomb's stream is built once: 2 GiB of zeros compress to about 2 MB.
const bombSize = 2048 * MiB;
let bomb: Part;

beforeAll(async () => {
  valid = await readPack(
    new URL(
      '../../../../packages/template-tools/fixtures/valid/',
      import.meta.url,
    ),
  );
  bomb = await understated('assets/junk.png', bombSize);
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
}, 30_000);

test('the crafted zips are what the tests claim', async () => {
  const smallPart = await understated('junk.png', 5 * MiB);
  const small = assemble([smallPart]);
  expect(firstEntry(small)).toMatchObject({
    flags: 0x0800,
    method: 8,
    localSize: 10,
    centralSize: 10,
  });
  expect(inflateRawSync(smallPart.stream).length).toBe(5 * MiB);

  const big = assemble([bomb]);
  expect(big.byteLength).toBeLessThan(3 * MiB);
  expect(firstEntry(big)).toMatchObject({
    localSize: 10,
    centralSize: 10,
    localCompressed: bomb.stream.byteLength,
    centralCompressed: bomb.stream.byteLength,
  });

  const files = { 'a.txt': strToU8('hello'), 'b.txt': strToU8('world') };
  const streamed = assemble(honestParts(files, () => ({ descriptor: true })));
  expect(firstEntry(streamed)).toMatchObject({
    flags: 0x0808,
    localSize: 0,
    localCompressed: 0,
    centralSize: 5,
  });
  expect(unzipSync(streamed)).toEqual(files);
  expect(
    unzipSync(assemble(honestParts(files, () => ({ method: 0 })))),
  ).toEqual(files);
});

test('refuses a listed asset whose declared size hides a multi-GiB inflation, promptly and storing nothing', async () => {
  // Regression: limits trusting the declared size let one 10 MiB upload make
  // the Worker inflate ~10 GiB and still pass as a 10-byte file.
  const files = { ...valid };
  listAsset(files, 'assets/junk.png');
  const zip = assemble([...honestParts(files), bomb]);
  expect(zip.byteLength).toBeLessThan(10 * MiB);
  const error = await refused(zip);
  expect(names(error)).toContain('junk.png');
}, 6_000);

test('refuses an unlisted extra file whose declared size hides a multi-GiB inflation, promptly and storing nothing', async () => {
  // Regression: the declared-size check covering only manifest-listed assets,
  // or only binary-named files.
  const zip = assemble([
    ...honestParts(valid),
    { ...bomb, name: 'extras/junk.png' },
  ]);
  const error = await refused(zip);
  expect(names(error)).toContain('junk.png');
}, 6_000);

test('refuses an entry that inflates to 5 MiB although it declares 10 bytes', async () => {
  // Regression: a small, under-the-cap lie being accepted: the entry's
  // content must match what its header says, not just stay under 20 MiB.
  const files = { ...valid };
  listAsset(files, 'assets/junk.png');
  const zip = assemble([
    ...honestParts(files),
    await understated('assets/junk.png', 5 * MiB),
  ]);
  const error = await refused(zip);
  expect(names(error)).toContain('junk.png');
});

test('accepts the valid fixture zipped with data descriptors and downloads it byte-identical', async () => {
  // Regression: refusing every entry whose local header has sizes 0 (flag
  // bit 3), which is how macOS Archive Utility and streamed zips are written.
  const zip = assemble(honestParts(valid, () => ({ descriptor: true })));
  expect(firstEntry(zip).flags & 0x0008).toBe(0x0008);
  expect(firstEntry(zip).localSize).toBe(0);
  expect(unzipSync(zip)).toEqual(valid);
  await acceptedAndDownloaded(zip);
});

test('accepts the valid fixture with stored (method 0) entries and downloads it byte-identical', async () => {
  // Regression: a size check that assumes every entry is deflated, e.g.
  // reading a stored entry's compressed size as a zero-length stream.
  const zip = assemble(honestParts(valid, () => ({ method: 0 })));
  expect(firstEntry(zip).method).toBe(0);
  expect(unzipSync(zip)).toEqual(valid);
  await acceptedAndDownloaded(zip);
});
