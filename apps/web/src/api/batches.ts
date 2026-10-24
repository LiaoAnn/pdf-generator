// The batch API (T16): start a batch, follow its progress, list its fixtures,
// re-run it. The work itself runs in src/batch/workflow.ts.
import {
  type Batch,
  type BatchRequest,
  batchRequestSchema,
  type Fixture,
  type FixtureList,
} from '@pdf-generator/contract';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { type FixtureFile, fixtureKey } from '../batch/fixture.ts';
import {
  readBatch,
  readBatches,
  readFixtureRows,
  toBatch,
} from '../batch/store.ts';
import { fixtureEntries, zipStream } from '../batch/zip.ts';
import { batches, fixtures } from '../db/schema.ts';
import { BatchRunner, Database, Files } from '../services.ts';
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

// Every index of a batch, pending until it has a row.
const fixtureList = (batch: Batch) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* database('read the fixtures', () =>
      readFixtureRows(db, batch.id),
    );
    const byIndex = new Map(rows.map(row => [row.index, row]));
    const list: FixtureList = {
      batchId: batch.id,
      fixtures: Array.from({ length: batch.count }, (_, index): Fixture => {
        const row = byIndex.get(index);
        if (!row) return { index, status: 'pending' };
        return row.status === 'failed'
          ? { index, status: 'failed', error: row.error ?? 'failed' }
          : {
              index,
              status: 'completed',
              ...(row.checkPassed !== null &&
                row.checkDifferences !== null && {
                  check: {
                    passed: row.checkPassed,
                    differences: row.checkDifferences,
                  },
                }),
            };
      }),
    };
    return list;
  });

/** GET /api/batches/:id/fixtures */
export const listFixtures = (id: string) =>
  found(id).pipe(
    Effect.flatMap(fixtureList),
    Effect.map(list => Response.json(list)),
  );

// Batch `id` and the number of its fixture `index`, or 404 for an index that
// isn't a fixture of the batch (only canonical decimals count).
const fixtureIndex = (id: string, index: string) =>
  Effect.gen(function* () {
    const batch = yield* found(id);
    const number = Number(index);
    if (
      !/^(0|[1-9]\d*)$/.test(index) ||
      !Number.isSafeInteger(number) ||
      number >= batch.count
    ) {
      return yield* new ApiFailure({
        status: 404,
        code: 'fixture_not_found',
        message: `No fixture ${index} in batch ${id}.`,
      });
    }
    return number;
  });

// A completed fixture's stored file from R2; undefined when the fixture
// isn't completed or the file isn't stored.
const completedFile = (id: string, index: number, file: FixtureFile) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* database('read the fixture', () =>
      db
        .select()
        .from(fixtures)
        .where(and(eq(fixtures.batchId, id), eq(fixtures.index, index))),
    );
    if (row?.status !== 'completed') return undefined;
    const files = yield* Files;
    const object = yield* Effect.tryPromise({
      try: () => files.get(fixtureKey(id, index, file)),
      catch: cause => {
        console.error(`batches: reading the fixture's ${file} failed`, cause);
        return new ApiFailure({
          status: 500,
          code: 'storage_error',
          message: `Could not read the fixture's ${file}.`,
        });
      },
    });
    return object ?? undefined;
  });

/** GET /api/batches/:id/fixtures/:index/check */
export const getFixtureCheck = (id: string, index: string) =>
  Effect.gen(function* () {
    const number = yield* fixtureIndex(id, index);
    const object = yield* completedFile(id, number, 'check.json');
    if (!object) {
      return yield* new ApiFailure({
        status: 404,
        code: 'check_not_found',
        message: `No check for fixture ${index} in batch ${id}.`,
      });
    }
    return new Response(object.body, {
      headers: { 'content-type': 'application/json' },
    });
  });

const fileTypes: Record<FixtureFile, string> = {
  'fixture.pdf': 'application/pdf',
  'gt.json': 'application/json',
  'data.json': 'application/json',
  'check.json': 'application/json',
};

const isFixtureFile = (file: string): file is FixtureFile =>
  Object.hasOwn(fileTypes, file);

/** GET /api/batches/:id/fixtures/:index/:file: one file of one fixture. */
export const downloadFixtureFile = (id: string, index: string, file: string) =>
  Effect.gen(function* () {
    const number = yield* fixtureIndex(id, index);
    const missing = new ApiFailure({
      status: 404,
      code: 'file_not_found',
      message: `No file ${file} for fixture ${index} in batch ${id}.`,
    });
    if (!isFixtureFile(file)) return yield* missing;
    const object = yield* completedFile(id, number, file);
    if (!object) return yield* missing;
    const name = `${id}-${String(number).padStart(4, '0')}-${file}`;
    return new Response(object.body, {
      headers: {
        'content-type': fileTypes[file],
        'content-disposition': `attachment; filename="${name}"`,
      },
    });
  });

const encoder = new TextEncoder();

/** GET /api/batches/:id/zip: a finished batch's files as one zip. */
export const downloadBatch = (id: string) =>
  Effect.gen(function* () {
    const batch = yield* found(id);
    if (batch.status !== 'completed' && batch.status !== 'failed') {
      return yield* new ApiFailure({
        status: 409,
        code: 'batch_not_finished',
        message: `Batch ${id} is ${batch.status}; download it once it has finished.`,
      });
    }
    const list = yield* fixtureList(batch);
    const files = yield* Files;
    const json = (value: unknown) =>
      encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
    const body = zipStream([
      { name: 'batch.json', bytes: json(batch) },
      { name: 'fixtures.json', bytes: json(list) },
      ...list.fixtures
        .filter(fixture => fixture.status === 'completed')
        .flatMap(fixture =>
          fixtureEntries(files, id, fixture.index, fixture.check !== undefined),
        ),
    ]);
    return new Response(body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${id}.zip"`,
      },
    });
  });

/** POST /api/batches/:id/rerun: the same request again, as a new batch. */
export const rerunBatch = (id: string) =>
  Effect.gen(function* () {
    const { templateId, templateVersion, count, seed } = yield* found(id);
    return yield* start({ templateId, templateVersion, count, seed }, id);
  });
