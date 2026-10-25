import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { brotliCompressSync, constants, deflateSync } from 'node:zlib';
import {
  type Manifest,
  manifestSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import * as schema from '../db/schema.ts';
import { templates } from '../db/schema.ts';
import { createFetchHandler } from '../worker.ts';
import { templateStore } from './store.ts';

type Files = Record<string, Uint8Array>;
const repoFiles = inject('repoFiles');
function repoFile(path: string): Uint8Array {
  const encoded = repoFiles[path];
  if (encoded === undefined) throw new Error(`Missing repo fixture: ${path}`);
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}
function requiredBytes(value: Uint8Array | undefined): Uint8Array {
  if (value === undefined) throw new Error('Test fixture bytes are missing');
  return value;
}
const fixturePrefix = 'packages/template-tools/fixtures/valid/';
const valid: Files = Object.fromEntries(
  Object.keys(repoFiles)
    .filter(path => path.startsWith(fixturePrefix))
    .map(path => [path.slice(fixturePrefix.length), repoFile(path)]),
);
const originalManifest = manifestSchema.parse(
  JSON.parse(strFromU8(requiredBytes(valid['manifest.json']))),
);
const local = createLocalAccess();
const handle = createFetchHandler({
  pages: async () =>
    new Response('API request reached the page handler', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
function request(path: string, body: Uint8Array) {
  return handle(
    new Request(new URL(path, 'https://web.example.test'), {
      method: 'POST',
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
        'content-type': 'application/zip',
      },
      body: new Uint8Array(body),
    }),
    env,
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

// A tiny compressed file whose name-only stream has a known decompression
// cost. No outlines are needed: upload treats font assets as opaque bytes.
function budgetFont(name: string, outputLength: number): Uint8Array {
  const stream = Buffer.alloc(outputLength);
  const text = Buffer.from(name, 'utf16le').swap16();
  stream.writeUInt16BE(1, 2);
  stream.writeUInt16BE(18, 4);
  stream.writeUInt16BE(3, 6);
  stream.writeUInt16BE(1, 8);
  stream.writeUInt16BE(0x409, 10);
  stream.writeUInt16BE(6, 12);
  stream.writeUInt16BE(text.length, 14);
  text.copy(stream, 18);
  const compressed = brotliCompressSync(stream, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 0 },
  });
  const length = [outputLength & 127];
  for (
    let rest = Math.floor(outputLength / 128);
    rest;
    rest = Math.floor(rest / 128)
  ) {
    length.unshift((rest & 127) | 128);
  }
  const directory = Buffer.from([5, ...length]);
  const header = Buffer.alloc(48);
  header.write('wOF2');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + directory.length + compressed.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, directory, compressed]);
}

// Reproduce the 42,926-byte KaTeX_Main-Regular output chunk regression.
function woffFont(name: string, outputLength: number): Uint8Array {
  const table = Buffer.alloc(outputLength);
  const text = Buffer.from(name, 'utf16le').swap16();
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(18, 4);
  table.writeUInt16BE(3, 6);
  table.writeUInt16BE(1, 8);
  table.writeUInt16BE(0x409, 10);
  table.writeUInt16BE(6, 12);
  table.writeUInt16BE(text.length, 14);
  text.copy(table, 18);
  const compressed = deflateSync(table);
  const header = Buffer.alloc(64);
  const padding = Buffer.alloc((4 - (compressed.length % 4)) % 4);
  header.write('wOFF');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + compressed.length + padding.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(28 + Math.ceil(outputLength / 4) * 4, 16);
  header.write('name', 44);
  header.writeUInt32BE(header.length, 48);
  header.writeUInt32BE(compressed.length, 52);
  header.writeUInt32BE(outputLength, 56);
  return Buffer.concat([header, compressed, padding]);
}
async function upload(bytes: Uint8Array) {
  const response = await request('/api/templates', bytes);
  expect(response.status).toBe(201);
  return templateSummarySchema.parse(await response.json());
}

async function hash(bytes: Uint8Array): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
  ).toString('hex');
}
beforeAll(async () => {
  const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});
beforeEach(async () => {
  await drizzle(env.DB).delete(templates);
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ cursor });
    if (page.objects.length)
      await env.FILES.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
});

describe('template storage HTTP acceptance in workerd with local D1 and R2', () => {
  test('uploaded pack read-back preserves every zip file as base64 and discovers its real WOFF2 PostScript name', async () => {
    const files = pack({ id: 'real-pack-font' });
    files['assets/report.woff2'] = repoFile(
      'apps/print/src/test-fixtures/pack-font/report.woff2',
    );
    const summary = await upload(zipSync(files));
    const stored = await templateStore(
      drizzle(env.DB, { schema }),
      env.FILES,
    ).get(summary.id, summary.version);
    expect(stored).toBeDefined();
    expect.soft(stored?.fonts).toEqual(['LXGWWenKaiTC-Regular']);
    expect(stored?.files).toBeDefined();
    expect(Object.keys(stored?.files ?? {}).sort()).toEqual(
      Object.keys(files).sort(),
    );
    for (const [path, bytes] of Object.entries(files)) {
      const encoded = stored?.files[path];
      expect(typeof encoded, path).toBe('string');
      const decoded = Buffer.from(encoded ?? '', 'base64');
      expect(decoded.length, path).toBe(bytes.length);
      expect(await hash(decoded), path).toBe(await hash(bytes));
      expect(encoded?.length, path).toBe(Math.ceil(bytes.length / 3) * 4);
    }
  });

  test('stored font names are sorted and unique across case-insensitive font paths while unreadable fonts are ignored', async () => {
    const files = pack({ id: 'multiple-pack-fonts' });
    const noto = repoFile('apps/print/public/fonts/NotoSansTC-Regular.otf');
    const wenkai = repoFile(
      'apps/print/src/test-fixtures/pack-font/report.woff2',
    );
    addAssets(files, {
      'assets/z-font.OTF': new Uint8Array(noto),
      'assets/a-font.WOFF2': new Uint8Array(wenkai),
      'assets/duplicate.woff2': new Uint8Array(wenkai),
      'assets/not-a-font.ttf': strToU8('not a font'),
    });
    // The original assets/report.woff2 is deliberately still the unreadable placeholder.
    const summary = await upload(zipSync(files));
    const stored = await templateStore(
      drizzle(env.DB, { schema }),
      env.FILES,
    ).get(summary.id, summary.version);
    expect(stored?.fonts).toEqual([
      'LXGWWenKaiTC-Regular',
      'NotoSansTC-Regular',
    ]);
  });

  test('stored pack stops discovering font names after 64 MiB of cumulative decompressed font output', async () => {
    const files = pack({ id: 'font-decompression-budget' });
    addAssets(files, {
      'assets/first.woff2': budgetFont('First-Within-Budget', 32 * 1024 * 1024),
      'assets/second.woff2': budgetFont(
        'Second-Within-Budget',
        32 * 1024 * 1024,
      ),
      'assets/beyond.woff2': budgetFont('Beyond-Pack-Budget', 256),
    });
    const summary = await upload(zipSync(files));
    const stored = await templateStore(
      drizzle(env.DB, { schema }),
      env.FILES,
    ).get(summary.id, summary.version);
    expect(stored?.fonts).toEqual([
      'First-Within-Budget',
      'Second-Within-Budget',
    ]);
    // Exhausting name discovery must not discard assets used by rendering.
    expect(stored?.files['assets/beyond.woff2']).toBe(
      Buffer.from(requiredBytes(files['assets/beyond.woff2'])).toString(
        'base64',
      ),
    );
  });

  test('uploaded WOFF and WOFF2 fonts with 42,926-byte name data retain both PostScript names in workerd', async () => {
    const files = pack({ id: 'large-font-name-data' });
    addAssets(files, {
      'assets/katex.woff': woffFont('KaTeX_Main-Regular', 42_926),
      'assets/katex.woff2': budgetFont('KaTeX_Main-Regular-WOFF2', 42_926),
    });
    const summary = await upload(zipSync(files));
    const stored = await templateStore(
      drizzle(env.DB, { schema }),
      env.FILES,
    ).get(summary.id, summary.version);
    expect(stored?.fonts).toEqual([
      'KaTeX_Main-Regular',
      'KaTeX_Main-Regular-WOFF2',
    ]);
  });
});
