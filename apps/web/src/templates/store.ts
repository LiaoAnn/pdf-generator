// Uploaded template versions: the zip in R2 under its SHA-256, a row per
// version in D1. Versions never change once written, so a batch that names one
// always gets the same pack.

import { Buffer } from 'node:buffer';
import {
  type Manifest,
  manifestSchema,
  rulesSchema,
  type TemplateSummary,
} from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { strFromU8 } from 'fflate';
import * as schema from '../db/schema.ts';
import { postScriptName } from './font-names.ts';
import { maxPackBytes } from './limits.ts';
import type { TemplatePack, TemplateSourceApi } from './source.ts';
import { unzipBounded } from './unzip.ts';

const { templates } = schema;
type Db = DrizzleD1Database<typeof schema>;
export type TemplateRow = typeof templates.$inferSelect;

/** Where a pack's zip lives in R2; the same bytes share one object. */
function packKey(id: string, sha256: string): string {
  return `templates/${id}/${sha256}.zip`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
  );
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export function toSummary(row: TemplateRow): TemplateSummary {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    ...(row.description !== null && { description: row.description }),
    page: { size: row.pageSize, orientation: row.orientation },
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Stores a checked pack as the next version of its template. The zip goes to
 * R2 first, so a row never points at a missing object; the version is chosen
 * inside the insert, so concurrent uploads of one id get distinct versions.
 */
export async function saveVersion(
  db: Db,
  files: R2Bucket,
  manifest: Manifest,
  zip: Uint8Array,
): Promise<TemplateRow> {
  const hash = await sha256(zip);
  await files.put(packKey(manifest.id, hash), zip, {
    httpMetadata: { contentType: 'application/zip' },
  });
  const [row] = await db
    .insert(templates)
    .values({
      id: manifest.id,
      version: sql`(select coalesce(max(${templates.version}), 0) + 1 from ${templates} where ${templates.id} = ${manifest.id})`,
      name: manifest.name,
      description: manifest.description,
      pageSize: manifest.page.size,
      orientation: manifest.page.orientation,
      packSha256: hash,
    })
    .returning();
  if (!row) throw new Error(`no row returned for ${manifest.id}`);
  return row;
}

/** Every version, by id then version; only `id`'s when given. */
export function readVersions(db: Db, id?: string): Promise<TemplateRow[]> {
  return db
    .select()
    .from(templates)
    .where(id === undefined ? undefined : eq(templates.id, id))
    .orderBy(asc(templates.id), asc(templates.version));
}

export async function readVersion(
  db: Db,
  id: string,
  version: number,
): Promise<TemplateRow | undefined> {
  const [row] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.version, version)));
  return row;
}

/** The zip of a stored version, or undefined if R2 has lost it. */
export async function readPackZip(
  files: R2Bucket,
  row: TemplateRow,
): Promise<R2ObjectBody | null> {
  return files.get(packKey(row.id, row.packSha256));
}

// The parts of a stored zip a batch needs. It passed checkPack on upload, so
// it is only parsed here, not checked again.
function unpack(zip: Uint8Array): TemplatePack {
  const unzipped = unzipBounded(zip, maxPackBytes);
  if ('issue' in unzipped) throw new Error(unzipped.issue.message);
  const { files } = unzipped;
  const text = (path: string) => {
    const bytes = files[path];
    if (bytes === undefined) throw new Error(`the stored pack has no ${path}`);
    return strFromU8(bytes);
  };
  const manifest = manifestSchema.parse(JSON.parse(text('manifest.json')));
  const rules = rulesSchema.parse(JSON.parse(text(manifest.files.rules)));
  return {
    manifest,
    template: text(manifest.files.template),
    styles: manifest.files.styles.map(text),
    rules,
    sample: recordSchema(rules).parse(JSON.parse(text(manifest.files.sample))),
    files: Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [
        path,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
          'base64',
        ),
      ]),
    ),
    fonts: [
      ...new Set(
        Object.entries(files).flatMap(([path, bytes]) => {
          const name = fontFile.test(path) ? postScriptName(bytes) : undefined;
          return name === undefined ? [] : [name];
        }),
      ),
    ].sort(),
  };
}

const fontFile = /\.(?:woff2?|ttf|otf)$/i;

const packBytes = (pack: TemplatePack) =>
  Object.values(pack.files).reduce((sum, file) => sum + file.length, 0);

// Unpacked versions, newest use last. A version never changes, so an entry
// stays valid; the bounds keep an isolate's memory small (a pack's files can
// be 27 MiB as base64). The newest entry is kept whatever its size.
const unpacked = new Map<string, TemplatePack>();
const maxUnpacked = 8;
const maxUnpackedBytes = 32 * 1024 * 1024;

/** Template versions as batches read them: uploaded packs in R2 + D1. */
export function templateStore(db: Db, files: R2Bucket): TemplateSourceApi {
  return {
    async get(id, version) {
      const row = await readVersion(db, id, version);
      if (!row) return undefined;
      const key = `${row.id}/${row.version}/${row.packSha256}`;
      let pack = unpacked.get(key);
      if (pack) {
        unpacked.delete(key);
      } else {
        const object = await readPackZip(files, row);
        if (!object) {
          throw new Error(`template ${id} version ${version}: zip missing`);
        }
        pack = unpack(new Uint8Array(await object.arrayBuffer()));
      }
      unpacked.set(key, pack);
      let bytes = [...unpacked.values()].reduce(
        (sum, kept) => sum + packBytes(kept),
        0,
      );
      for (const [old, kept] of unpacked) {
        if (old === key) break;
        if (unpacked.size <= maxUnpacked && bytes <= maxUnpackedBytes) break;
        unpacked.delete(old);
        bytes -= packBytes(kept);
      }
      return pack;
    },
  };
}
