// The batch API (T16): start a batch, follow its progress, list its fixtures,
// re-run it. The work itself runs in src/batch/workflow.ts.
import {
  type BatchRequest,
  batchRequestSchema,
  type Fixture,
  type FixtureList,
} from '@pdf-generator/contract';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import {
  readBatch,
  readBatches,
  readFixtureRows,
  toBatch,
} from '../batch/store.ts';
import { batches } from '../db/schema.ts';
import { BatchRunner, Database } from '../services.ts';
import { TemplateSource } from '../templates/source.ts';
import { ApiFailure } from './errors.ts';

function database<A>(what: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: cause => {
      console.error(`batches: ${what} failed`, cause);
      return new ApiFailure({
        status: 500,
        code: 'database_error',
        message: `Could not ${what}.`,
      });
    },
  });
}

const notFound = (id: string) =>
  new ApiFailure({
    status: 404,
    code: 'batch_not_found',
    message: `No batch ${id}.`,
  });

const found = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const batch = yield* database('read the batch', () => readBatch(db, id));
    if (!batch) return yield* notFound(id);
    return batch;
  });

// Records a queued batch and starts its Workflow; a batch whose Workflow
// can't be started is recorded as failed rather than left queued.
const start = (input: BatchRequest, rerunOf?: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const runner = yield* BatchRunner;
    const [row] = yield* database('record the batch', () =>
      db
        .insert(batches)
        .values({
          id: crypto.randomUUID(),
          ...input,
          status: 'queued',
          rerunOf,
        })
        .returning(),
    );
    if (!row) {
      return yield* new ApiFailure({
        status: 500,
        code: 'database_error',
        message: 'Could not record the batch.',
      });
    }
    const started = yield* Effect.tryPromise(() => runner.start(row.id)).pipe(
      Effect.as(true),
      Effect.catch(cause =>
        Effect.sync(() => {
          console.error(`batches: starting ${row.id} failed`, cause);
          return false;
        }),
      ),
    );
    if (!started) {
      yield* database('record the failed start', () =>
        db
          .update(batches)
          .set({ status: 'failed', finishedAt: new Date() })
          .where(eq(batches.id, row.id)),
      );
      return yield* new ApiFailure({
        status: 503,
        code: 'batch_start_failed',
        message: 'The batch was recorded but could not be started.',
      });
    }
    return Response.json(toBatch(row), { status: 201 });
  });

/** POST /api/batches */
export const createBatch = (request: Request) =>
  Effect.gen(function* () {
    const json = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () =>
        new ApiFailure({
          status: 400,
          code: 'invalid_request',
          message: 'The body is not valid JSON.',
        }),
    });
    const parsed = batchRequestSchema.safeParse(json);
    if (!parsed.success) {
      return yield* new ApiFailure({
        status: 400,
        code: 'invalid_request',
        message: 'The body is not a batch request.',
        details: parsed.error.issues.map(issue => ({
          message: issue.message,
          path: issue.path.filter(
            (key): key is string | number => typeof key !== 'symbol',
          ),
        })),
      });
    }
    const { templateId, templateVersion } = parsed.data;
    const templates = yield* TemplateSource;
    const pack = yield* Effect.tryPromise({
      try: () => templates.get(templateId, templateVersion),
      catch: cause => {
        console.error('batches: reading the template failed', cause);
        return new ApiFailure({
          status: 500,
          code: 'template_unavailable',
          message: 'Could not read the template.',
        });
      },
    });
    if (!pack) {
      return yield* new ApiFailure({
        status: 404,
        code: 'template_not_found',
        message: `No template ${templateId} version ${templateVersion}.`,
      });
    }
    return yield* start(parsed.data);
  });

/** GET /api/batches */
export const listBatches = Effect.gen(function* () {
  const db = yield* Database;
  const list = yield* database('read the batch list', () => readBatches(db));
  return Response.json({ batches: list });
});

/** GET /api/batches/:id */
export const getBatch = (id: string) =>
  found(id).pipe(Effect.map(batch => Response.json(batch)));

/** GET /api/batches/:id/fixtures: every index, pending until it has a row. */
export const listFixtures = (id: string) =>
  Effect.gen(function* () {
    const batch = yield* found(id);
    const db = yield* Database;
    const rows = yield* database('read the fixtures', () =>
      readFixtureRows(db, id),
    );
    const byIndex = new Map(rows.map(row => [row.index, row]));
    const body: FixtureList = {
      batchId: id,
      fixtures: Array.from({ length: batch.count }, (_, index): Fixture => {
        const row = byIndex.get(index);
        if (!row) return { index, status: 'pending' };
        return row.status === 'failed'
          ? { index, status: 'failed', error: row.error ?? 'failed' }
          : { index, status: 'completed' };
      }),
    };
    return Response.json(body);
  });

/** POST /api/batches/:id/rerun: the same request again, as a new batch. */
export const rerunBatch = (id: string) =>
  Effect.gen(function* () {
    const { templateId, templateVersion, count, seed } = yield* found(id);
    return yield* start({ templateId, templateVersion, count, seed }, id);
  });
