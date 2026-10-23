// One batch, start to finish (T16): mark it running, enqueue one message per
// fixture (queue.ts makes them), wait until every fixture has finished, then
// mark the batch completed. Workflows replays finished steps by name, so a
// restarted run doesn't enqueue twice.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema.ts';
import type { FixtureJob } from './fixture.ts';
import { fixturesDone } from './queue.ts';
import { countFinished, readBatchRow } from './store.ts';

interface BatchParams {
  batchId: string;
}

/** The part of WorkflowStep a batch uses. */
export interface BatchSteps {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  waitForEvent(
    name: string,
    options: { type: string; timeout: string },
  ): Promise<unknown>;
}

interface BatchDeps {
  db: DrizzleD1Database<typeof schema>;
  queue: { sendBatch(messages: Iterable<{ body: FixtureJob }>): Promise<void> };
}

// Queues accepts at most 100 messages per sendBatch.
const chunkSize = 100;

export async function runBatch(
  batchId: string,
  step: BatchSteps,
  deps: BatchDeps,
  // 288 waits of 5 minutes: a batch gets 24 hours.
  { waitTimeout = '5 minutes', maxWaits = 288 } = {},
): Promise<void> {
  const { db } = deps;
  const finish = (status: 'completed' | 'failed') =>
    step.do(`finish ${status}`, async () => {
      await db
        .update(schema.batches)
        .set({ status, finishedAt: new Date() })
        .where(eq(schema.batches.id, batchId));
    });

  try {
    const batch = await step.do('start', async () => {
      const row = await readBatchRow(db, batchId);
      if (!row) throw new Error(`no batch ${batchId}`);
      await db
        .update(schema.batches)
        .set({ status: 'running' })
        .where(eq(schema.batches.id, batchId));
      const { templateId, templateVersion, seed, count } = row;
      return { templateId, templateVersion, seed, count };
    });

    for (let from = 0; from < batch.count; from += chunkSize) {
      const to = Math.min(from + chunkSize, batch.count);
      await step.do(`enqueue ${from}-${to - 1}`, async () => {
        const { count: _, ...job } = batch;
        await deps.queue.sendBatch(
          Array.from({ length: to - from }, (_, i) => ({
            body: { batchId, ...job, index: from + i },
          })),
        );
      });
    }

    for (let waits = 0; ; waits++) {
      const finished = await step.do(`progress ${waits}`, () =>
        countFinished(db, batchId),
      );
      if (finished >= batch.count) return await finish('completed');
      if (waits >= maxWaits) return await finish('failed');
      // The queue consumer sends the event when the last fixture finishes;
      // a timed-out wait just checks again.
      await step
        .waitForEvent(`wait ${waits}`, {
          type: fixturesDone,
          timeout: waitTimeout,
        })
        .catch(() => undefined);
    }
  } catch (error) {
    await finish('failed');
    throw error;
  }
}

export class BatchWorkflow extends WorkflowEntrypoint<Env, BatchParams> {
  override async run(
    event: WorkflowEvent<BatchParams>,
    step: WorkflowStep,
  ): Promise<void> {
    // WorkflowStep does what BatchSteps says; its types only add the
    // serialisable-result and duration-literal constraints runBatch meets.
    const steps = step as unknown as BatchSteps;
    const queue = this.env.FIXTURES;
    await runBatch(event.payload.batchId, steps, {
      db: drizzle(this.env.DB, { schema }),
      queue: {
        sendBatch: async messages => {
          await queue.sendBatch(messages);
        },
      },
    });
  }
}
