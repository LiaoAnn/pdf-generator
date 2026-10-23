import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { Database, Files } from '../services.ts';
import { ApiFailure } from './errors.ts';

/** GET /api/status: whether D1 and R2 answer. */
export const status = Effect.gen(function* () {
  const db = yield* Database;
  const files = yield* Files;
  const checks: Record<'d1' | 'r2', () => Promise<unknown>> = {
    d1: async () => db.run(sql`select 1`),
    r2: async () => files.head('status-probe'),
  };
  const failed = yield* Effect.forEach(
    Object.entries(checks),
    ([name, check]) =>
      Effect.tryPromise(check).pipe(
        Effect.as(undefined),
        Effect.catch(error =>
          Effect.sync(() => {
            console.error(`status: ${name} check failed`, error);
            return name;
          }),
        ),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map(names => names.filter(name => name !== undefined)));

  if (failed.length > 0) {
    return yield* new ApiFailure({
      status: 503,
      code: 'dependency_unavailable',
      message: 'A storage dependency is unavailable.',
      details: failed.map(name => ({ message: `${name} is unavailable` })),
    });
  }
  return Response.json({ status: 'ok', checks: { d1: 'ok', r2: 'ok' } });
});
