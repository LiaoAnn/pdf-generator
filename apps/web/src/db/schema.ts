// The D1 schema. Change it, then run `pnpm db:generate`; never write or edit
// migrations by hand (AGENTS.md).
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/** One uploaded version of a template pack (the contract's TemplateSummary). */
export const templates = sqliteTable(
  'templates',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    pageSize: text('page_size', { enum: ['A4'] }).notNull(),
    orientation: text('orientation', {
      enum: ['portrait', 'landscape'],
    }).notNull(),
    /** SHA-256 hex of the uploaded zip, which R2 keeps under packKey(). */
    packSha256: text('pack_sha256').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`),
  },
  table => [primaryKey({ columns: [table.id, table.version] })],
);

/** A batch: `count` fixtures from one template version and seed (T16). */
export const batches = sqliteTable(
  'batches',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(),
    templateVersion: integer('template_version').notNull(),
    count: integer('count').notNull(),
    seed: text('seed').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'completed', 'failed'],
    }).notNull(),
    rerunOf: text('rerun_of'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  table => [index('batches_created_at').on(table.createdAt)],
);

/**
 * One finished fixture of a batch. A fixture without a row is still pending;
 * its files are in R2 under the batch's prefix (src/batch/files.ts).
 */
export const fixtures = sqliteTable(
  'fixtures',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    index: integer('fixture_index').notNull(),
    status: text('status', { enum: ['completed', 'failed'] }).notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull(),
    pageCount: integer('page_count'),
    /** SHA-256 hex of the stored files, to compare a batch with its re-run. */
    dataSha256: text('data_sha256'),
    gtSha256: text('gt_sha256'),
    pdfSha256: text('pdf_sha256'),
  },
  table => [primaryKey({ columns: [table.batchId, table.index] })],
);
