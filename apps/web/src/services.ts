// The Worker's bindings as Effect services. API routes ask for what they use
// (`yield* Database`) and worker.ts provides them from `env` per request, so
// tests and later tickets can provide stand-ins without touching the routes.
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { Context, Effect } from 'effect';
import * as schema from './db/schema.ts';

/** D1 through Drizzle, typed by src/db/schema.ts. */
export class Database extends Context.Service<
  Database,
  DrizzleD1Database<typeof schema>
>()('Database') {}

/** The R2 bucket for template packs and generated fixtures. */
export class Files extends Context.Service<Files, R2Bucket>()('Files') {}

export type Services = Database | Files;

export function provideServices(env: Env) {
  return <A, E>(effect: Effect.Effect<A, E, Services>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(Database, drizzle(env.DB, { schema })),
      Effect.provideService(Files, env.FILES),
    );
}
