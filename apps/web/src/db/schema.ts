// The D1 schema. Change it, then run `pnpm db:generate`; never write or edit
// migrations by hand (AGENTS.md).
import { sql } from 'drizzle-orm';
import {
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
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`),
  },
  table => [primaryKey({ columns: [table.id, table.version] })],
);
