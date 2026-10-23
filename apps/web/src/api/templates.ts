import type { TemplateList } from '@pdf-generator/contract';
import { asc } from 'drizzle-orm';
import { Effect } from 'effect';
import { templates } from '../db/schema.ts';
import { Database } from '../services.ts';
import { ApiFailure } from './errors.ts';

/** GET /api/templates: every uploaded version, by id then version. */
export const listTemplates = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select()
        .from(templates)
        .orderBy(asc(templates.id), asc(templates.version)),
    catch: cause => {
      console.error('listTemplates: D1 query failed', cause);
      return new ApiFailure({
        status: 500,
        code: 'database_error',
        message: 'Could not read the template list.',
      });
    },
  });
  const body: TemplateList = {
    templates: rows.map(row => ({
      id: row.id,
      version: row.version,
      name: row.name,
      ...(row.description !== null && { description: row.description }),
      page: { size: row.pageSize, orientation: row.orientation },
      createdAt: row.createdAt.toISOString(),
    })),
  };
  return Response.json(body);
});
