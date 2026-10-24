// The Worker's bindings as Effect services. API routes ask for what they use
// (`yield* Database`) and worker.ts provides them from `env` per request, so
// tests and later tickets can provide stand-ins without touching the routes.
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { Context, Effect } from 'effect';
import { type PdfJob, printPdf } from './batch/printer.ts';
import * as schema from './db/schema.ts';
import { TemplateSource } from './templates/source.ts';
import { templateStore } from './templates/store.ts';

/** D1 through Drizzle, typed by src/db/schema.ts. */
export class Database extends Context.Service<
  Database,
  DrizzleD1Database<typeof schema>
>()('Database') {}

/** The R2 bucket for template packs and generated fixtures. */
export class Files extends Context.Service<Files, R2Bucket>()('Files') {}

/** Starts the Workflow that produces a recorded batch (src/batch/workflow.ts). */
export class BatchRunner extends Context.Service<
  BatchRunner,
  { start: (batchId: string) => Promise<void> }
>()('BatchRunner') {}

/** Prints a document to PDF through the print Worker (the PRINT binding). */
export class Print extends Context.Service<
  Print,
  { pdf: (job: PdfJob) => Promise<Uint8Array<ArrayBuffer>> }
>()('Print') {}

export type Services = Database | Files | BatchRunner | TemplateSource | Print;

function database(env: Env): DrizzleD1Database<typeof schema> {
  return drizzle(env.DB, { schema });
}

export function provideServices(env: Env) {
  const db = database(env);
  return <A, E>(effect: Effect.Effect<A, E, Services>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(Database, db),
      Effect.provideService(Files, env.FILES),
      Effect.provideService(BatchRunner, {
        start: async batchId => {
          await env.BATCH_WORKFLOW.create({
            id: batchId,
            params: { batchId },
          });
        },
      }),
      Effect.provideService(TemplateSource, templateStore(db, env.FILES)),
      Effect.provideService(Print, {
        pdf: job => printPdf(env.PRINT, env.PRINT_TOKEN, job),
      }),
    );
}
