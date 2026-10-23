// How long batch results are kept (T16). One setting, BATCH_RETENTION_DAYS
// in wrangler.jsonc; the daily cron deletes finished batches older than it,
// files and rows. The same request reproduces a deleted batch.
import { and, eq, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema.ts';
import { batchPrefix } from './fixture.ts';

const day = 24 * 60 * 60 * 1000;

// A positive whole number of days, or undefined: a broken setting must never
// mean "delete everything".
function retentionDays(setting: string | undefined): number | undefined {
  return setting && /^[1-9]\d*$/.test(setting) ? Number(setting) : undefined;
}

async function deleteObjects(files: R2Bucket, prefix: string) {
  for (;;) {
    // R2 lists and deletes at most 1,000 keys per call; deleting what was
    // listed moves the next page to the front.
    const listed = await files.list({ prefix, limit: 1000 });
    if (listed.objects.length === 0) return;
    await files.delete(listed.objects.map(object => object.key));
    if (!listed.truncated) return;
  }
}

/** Deletes the expired finished batches; returns their ids. */
export async function deleteExpiredBatches(
  env: { DB: D1Database; FILES: R2Bucket; BATCH_RETENTION_DAYS?: string },
  now: Date,
): Promise<string[]> {
  const days = retentionDays(env.BATCH_RETENTION_DAYS);
  if (days === undefined) {
    console.error(
      `retention: BATCH_RETENTION_DAYS ${JSON.stringify(env.BATCH_RETENTION_DAYS)} is not a positive whole number; nothing deleted`,
    );
    return [];
  }
  const db = drizzle(env.DB, { schema });
  const { batches, fixtures } = schema;
  const expired = await db
    .select({ id: batches.id })
    .from(batches)
    .where(
      and(
        inArray(batches.status, ['completed', 'failed']),
        lt(batches.createdAt, new Date(now.getTime() - days * day)),
      ),
    );
  const deleted: string[] = [];
  for (const { id } of expired) {
    // Files first: a batch row without files is harmless, files without a
    // row would never be found again.
    await deleteObjects(env.FILES, batchPrefix(id));
    await db.delete(fixtures).where(eq(fixtures.batchId, id));
    await db.delete(batches).where(eq(batches.id, id));
    deleted.push(id);
  }
  if (deleted.length > 0) {
    console.log(`retention: deleted ${deleted.length} batches`, deleted);
  }
  return deleted;
}
