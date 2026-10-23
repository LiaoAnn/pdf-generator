// Batches and their fixtures in D1, shared by the API routes, the Workflow
// and the queue consumer. A batch's progress is counted from its fixture
// rows; a fixture without a row is pending.
import type { Batch } from '@pdf-generator/contract';
import { desc, eq, type SQL, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema.ts';

const { batches, fixtures } = schema;
type Db = DrizzleD1Database<typeof schema>;
export type BatchRow = typeof batches.$inferSelect;

const counted = (status: 'completed' | 'failed') =>
  sql<number>`coalesce(sum(${fixtures.status} = ${status}), 0)`.mapWith(Number);

function selectBatches(db: Db, where?: SQL) {
  return db
    .select({
      batch: batches,
      completed: counted('completed'),
      failed: counted('failed'),
    })
    .from(batches)
    .leftJoin(fixtures, eq(fixtures.batchId, batches.id))
    .where(where)
    .groupBy(batches.id);
}

/** The contract's Batch for a row and its progress. */
export function toBatch(
  row: BatchRow,
  progress: Batch['progress'] = { completed: 0, failed: 0 },
): Batch {
  return {
    id: row.id,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    count: row.count,
    seed: row.seed,
    status: row.status,
    progress,
    createdAt: row.createdAt.toISOString(),
    ...(row.finishedAt && { finishedAt: row.finishedAt.toISOString() }),
    ...(row.rerunOf !== null && { rerunOf: row.rerunOf }),
  };
}

const fromSelected = (row: {
  batch: BatchRow;
  completed: number;
  failed: number;
}) => toBatch(row.batch, { completed: row.completed, failed: row.failed });

export async function readBatch(
  db: Db,
  id: string,
): Promise<Batch | undefined> {
  const [found] = await selectBatches(db, eq(batches.id, id));
  return found && fromSelected(found);
}

/** Every batch, newest first. */
export async function readBatches(db: Db): Promise<Batch[]> {
  const rows = await selectBatches(db).orderBy(
    desc(batches.createdAt),
    desc(batches.id),
  );
  return rows.map(fromSelected);
}

export async function readFixtureRows(db: Db, batchId: string) {
  return db
    .select()
    .from(fixtures)
    .where(eq(fixtures.batchId, batchId))
    .orderBy(fixtures.index);
}
