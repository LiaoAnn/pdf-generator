// Uploaded template versions: the zip in R2 under its SHA-256, a row per
// version in D1. Versions never change once written, so a batch that names one
// always gets the same pack.
import type { Manifest, TemplateSummary } from '@pdf-generator/contract';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema.ts';

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
