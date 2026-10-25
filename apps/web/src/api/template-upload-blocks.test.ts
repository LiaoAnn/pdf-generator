import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { apiErrorSchema, templateListSchema } from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strToU8, zipSync } from 'fflate';
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

// Writes RFC 1951 bits least-significant bit first, including byte alignment
// for stored blocks. Fixtures are generated, never downloaded binary blobs.
class Bits {
  private data: Uint8Array;
  position = 0;
  constructor(capacity = 11 * 1024 * 1024) {
    this.data = new Uint8Array(capacity);
  }
  put(value: number, count: number) {
    for (let bit = 0; bit < count; bit++, this.position++) {
      if ((value >>> bit) & 1)
        this.data[this.position >>> 3] =
          (this.data[this.position >>> 3] ?? 0) | (1 << (this.position & 7));
    }
  }
  align() {
    while (this.position & 7) this.put(0, 1);
  }
  bytes() {
    return this.data.slice(0, Math.ceil(this.position / 8));
  }
}
type BlockKind = 'dynamic-1' | 'dynamic-15' | 'fixed' | 'stored';
function emptyBlock(bits: Bits, kind: BlockKind, final: boolean) {
  bits.put(final ? 1 : 0, 1);
  if (kind === 'stored') {
    bits.put(0, 2);
    bits.align();
    bits.put(0, 16);
    bits.put(65535, 16);
  } else if (kind === 'fixed') {
    bits.put(1, 2);
    bits.put(0, 7); // fixed EOB 256
  } else {
    bits.put(2, 2);
    bits.put(0, 5);
    bits.put(0, 5);
    const wide = kind === 'dynamic-15';
    bits.put(wide ? 15 : 14, 4); // HCLEN: include symbol 15 or stop at 1
    const order = [
      16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];
    for (const symbol of order.slice(0, wide ? 19 : 18)) {
      bits.put(
        wide
          ? [0, 1, 15, 18].includes(symbol)
            ? 2
            : 0
          : symbol === 0
            ? 1
            : [1, 18].includes(symbol)
              ? 2
              : 0,
        3,
      );
    }
    // Canonical code-length codes, reversed for the bit writer:
    // narrow: 0=0, 1=10, 18=11; wide: 0=00,1=01,15=10,18=11.
    for (const repeat of [138, 118]) {
      bits.put(3, 2);
      bits.put(repeat - 11, 7);
    }
    bits.put(1, 2); // EOB length: symbol 15 (10) or 1 (10)
    bits.put(wide ? 2 : 1, 2); // distance length 1 (01 or 10)
    bits.put(0, wide ? 15 : 1); // sole EOB code
  }
}
function bomb(kind: BlockKind): Uint8Array {
  const bits = new Bits();
  const blockBits =
    kind === 'dynamic-1'
      ? 94
      : kind === 'dynamic-15'
        ? 111
        : kind === 'fixed'
          ? 10
          : 40;
  // Leave room for the normal pack + ZIP headers below the HTTP 10 MiB cap.
  const count = Math.floor(((10 * 1024 * 1024 - 16_384) * 8) / blockBits);
  for (let i = 0; i < count; i++) emptyBlock(bits, kind, i === count - 1);
  return bits.bytes();
}
test.each<BlockKind>(['dynamic-1', 'dynamic-15', 'fixed', 'stored'])(
  'upload refuses a near-10 MiB stream of empty %s blocks with no storage',
  async kind => {
    const { parts, sizes } = validParts();
    const name = 'assets/report.woff2';
    const attack = { name, stream: bomb(kind), method: 8 as const, crc: 0 };
    sizes.set(name, 0);
    const zip = assemble(
      parts.map(entry => (entry.name === name ? attack : entry)),
      sizes,
    );
    expect(zip.length).toBeLessThan(10 * 1024 * 1024);
    const response = await request('/api/templates', zip);
    expect(response.status).toBe(400);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.details).toContainEqual(
      expect.objectContaining({ code: 'zip-too-many-blocks', file: name }),
    );
    expect(
      templateListSchema.parse(await (await request('/api/templates')).json())
        .templates,
    ).toEqual([]);
    expect((await platform.env.FILES.list()).objects).toEqual([]);
  },
  // The workerd test owns the 500 ms CPU assertion. Leave enough time here
  // for the vulnerable Node decoder to reach the HTTP assertion in RED.
  60_000,
);

test.each(['fflate', 'zlib'])(
  'every real pack uploads with %s compression, including paper fonts',
  async compressor => {
    const packs = new URL('../../../../templates/', import.meta.url);
    const names = (await readdir(packs, { withFileTypes: true })).filter(
      entry => entry.isDirectory(),
    );
    let uploaded = 0;
    for (const directory of names) {
      const root = new URL(`${directory.name}/pack/`, packs);
      // Only actual pack directories, not unrelated template tooling.
      let files: Files;
      try {
        files = await readPack(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const { parts, sizes } = validParts(files);
      const zip =
        compressor === 'fflate' ? zipSync(files) : assemble(parts, sizes);
      const response = await request('/api/templates', zip);
      expect(
        response.status,
        `${directory.name}: ${await response.clone().text()}`,
      ).toBe(201);
      uploaded++;
    }
    expect(uploaded).toBe(6);
  },
);

test('zip-too-many-blocks has its own Chinese explanation', () => {
  const explanation = (code: string) =>
    explainError({
      code: 'invalid_template_pack',
      message: 'Invalid pack',
      details: [
        { code, file: 'assets/report.woff2', message: 'Too many blocks' },
      ],
    }).issues[0]?.explanation;
  expect(explanation('zip-too-many-blocks')).toMatch(/[\u3400-\u9fff]/);
  expect(explanation('zip-too-many-blocks')).not.toBe(
    explanation('future-code'),
  );
});
