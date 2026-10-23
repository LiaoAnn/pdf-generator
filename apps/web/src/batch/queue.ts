// The fixture queue's consumer (T16): one message per fixture. A fixture is
// tried up to maxAttempts times (the queue redelivers it after a delay), then
// recorded as failed; either way it gets a row, and the last row of a batch
// wakes the batch's Workflow.
import { and, eq } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema.ts';
import {
  fixtureTemplates,
  type TemplateSourceApi,
} from '../templates/source.ts';
import { type FixtureJob, makeFixture } from './fixture.ts';
import { createPrinter, type Printer } from './printer.ts';
import { countFinished, readBatchRow } from './store.ts';

/** Tries per fixture; wrangler.jsonc's max_retries must allow at least this. */
const maxAttempts = 3;

/** The event a batch's Workflow waits for (workflow.ts). */
export const fixturesDone = 'fixtures-done';

export interface FixtureDeps {
  db: DrizzleD1Database<typeof schema>;
  files: R2Bucket;
  templates: TemplateSourceApi;
  printer: Printer;
  workflow: {
    get(id: string): Promise<{
      sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
    }>;
  };
}

// Waits before attempts 2 and 3: long enough for a restarted print Worker or
// a released browser, short enough for a batch to finish soon after.
const retryDelaySeconds = (attempts: number) => 5 * 3 ** (attempts - 1);

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000) ||
  'failed';

async function handle(message: Message<FixtureJob>, deps: FixtureDeps) {
  const job = message.body;
  const { db } = deps;
  const batch = await readBatchRow(db, job.batchId);
  if (!batch) {
    // Deleted (retention) or never existed: nothing to do.
    message.ack();
    return;
  }
  const [existing] = await db
    .select({ index: schema.fixtures.index })
    .from(schema.fixtures)
    .where(
      and(
        eq(schema.fixtures.batchId, job.batchId),
        eq(schema.fixtures.index, job.index),
      ),
    );
  if (existing) {
    // At-least-once delivery: this fixture already finished.
    message.ack();
    return;
  }

  let row: typeof schema.fixtures.$inferInsert;
  try {
    const files = await makeFixture(job, deps);
    row = {
      batchId: job.batchId,
      index: job.index,
      status: 'completed',
      attempts: message.attempts,
      ...files,
    };
  } catch (error) {
    if (message.attempts < maxAttempts) {
      console.warn(
        `fixture ${job.batchId}/${job.index} attempt ${message.attempts} failed, retrying`,
        error,
      );
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      return;
    }
    console.error(`fixture ${job.batchId}/${job.index} failed`, error);
    row = {
      batchId: job.batchId,
      index: job.index,
      status: 'failed',
      attempts: message.attempts,
      error: describe(error),
    };
  }
  await db.insert(schema.fixtures).values(row).onConflictDoNothing();
  message.ack();

  if ((await countFinished(db, job.batchId)) >= batch.count) {
    try {
      const instance = await deps.workflow.get(job.batchId);
      await instance.sendEvent({ type: fixturesDone });
    } catch (error) {
      // The Workflow also rechecks progress after each wait times out.
      console.warn(`batch ${job.batchId}: completion event not sent`, error);
    }
  }
}

export async function handleFixtureMessages(
  messages: readonly Message<FixtureJob>[],
  deps: FixtureDeps,
): Promise<void> {
  await Promise.all(
    messages.map(async message => {
      try {
        await handle(message, deps);
      } catch (error) {
        // D1 or R2 failed outside makeFixture: let the queue redeliver.
        console.error('fixture message failed', error);
        message.retry({ delaySeconds: retryDelaySeconds(1) });
      }
    }),
  );
}

// One printer per isolate, so its kept browser sessions outlive a delivery.
let printer: { token: string; printer: Printer } | undefined;

/** The Worker's `queue` handler. */
export async function consumeFixtures(
  batch: MessageBatch<FixtureJob>,
  env: Env,
): Promise<void> {
  if (printer?.token !== env.PRINT_TOKEN) {
    printer = {
      token: env.PRINT_TOKEN,
      printer: createPrinter(env.PRINT, env.PRINT_TOKEN),
    };
  }
  await handleFixtureMessages(batch.messages, {
    db: drizzle(env.DB, { schema }),
    files: env.FILES,
    templates: fixtureTemplates,
    printer: printer.printer,
    workflow: env.BATCH_WORKFLOW,
  });
}
