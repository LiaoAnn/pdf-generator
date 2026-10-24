// Request and response bodies of the platform API, shared by the website
// Worker, its pages and the Mac-side tools that upload template packs.
import { z } from 'zod';
import { relativePathSchema, seedSchema, slugSchema } from './primitives.ts';

/** Most fixtures one batch may produce. */
export const maxBatchCount = 1000;

const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
  .describe('UTC time, e.g. 2026-10-23T15:46:22.998Z.');
const batchId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const count = z.int().min(1).max(maxBatchCount);

/** The body of every error response. */
export const apiErrorSchema = z
  .strictObject({
    error: z.strictObject({
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .describe('Stable, machine-readable, e.g. invalid_template_pack.'),
      message: z.string().min(1).describe('Human-readable summary.'),
      details: z
        .array(
          z
            .strictObject({
              message: z.string().min(1),
              code: z
                .string()
                .regex(/^[a-z][a-z0-9_-]*$/)
                .optional()
                .describe(
                  'Stable code of this problem, e.g. file-missing or font_not_loaded.',
                ),
              file: relativePathSchema
                .optional()
                .describe('File inside the uploaded template pack.'),
              line: z.int().min(1).optional(),
              column: z.int().min(1).optional(),
              path: z
                .array(z.union([z.string(), z.int().min(0)]))
                .optional()
                .describe('Where in a JSON document, as keys and indexes.'),
            })
            .refine(
              detail =>
                detail.column === undefined || detail.line !== undefined,
              {
                message: 'column needs line',
                path: ['column'],
              },
            ),
        )
        .optional()
        .describe('One entry per problem, each pointing at where it is.'),
    }),
  })
  .meta({
    title: 'API error',
    description:
      'Body of every error response. Not expressible in JSON Schema: a detail with column also has line.',
  });

export type ApiError = z.infer<typeof apiErrorSchema>;

/** One uploaded version of a template. */
export const templateSummarySchema = z
  .strictObject({
    id: slugSchema,
    version: z
      .int()
      .min(1)
      .describe('Each upload of the same id adds a version.'),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    page: z.strictObject({
      size: z.literal('A4'),
      orientation: z.enum(['portrait', 'landscape']),
    }),
    createdAt: timestamp,
  })
  .meta({
    title: 'Template summary',
    description: 'One uploaded version of a template.',
  });

export type TemplateSummary = z.infer<typeof templateSummarySchema>;

export const templateListSchema = z
  .strictObject({ templates: z.array(templateSummarySchema) })
  .meta({ title: 'Template list' });

export type TemplateList = z.infer<typeof templateListSchema>;

/** Starts a batch: `count` fixtures from one template version and seed. */
export const batchRequestSchema = z
  .strictObject({
    templateId: slugSchema,
    templateVersion: z.int().min(1),
    count,
    seed: seedSchema,
  })
  .meta({
    title: 'Batch request',
    description:
      'Starts a batch of fixtures from one template version and seed.',
  });

export type BatchRequest = z.infer<typeof batchRequestSchema>;

const batchStatus = z.enum(['queued', 'running', 'completed', 'failed']);

const batchObject = batchRequestSchema.extend({
  id: batchId,
  status: batchStatus,
  progress: z
    .strictObject({
      completed: z.int().min(0),
      failed: z.int().min(0),
      checkPassed: z
        .int()
        .min(0)
        .describe('Completed fixtures whose self-check passed.'),
      checkFailed: z
        .int()
        .min(0)
        .describe('Completed fixtures whose self-check failed.'),
    })
    .describe('Fixtures finished so far, by outcome.'),
  createdAt: timestamp,
  finishedAt: timestamp
    .optional()
    .describe('Set once the batch is completed or failed.'),
  rerunOf: batchId.optional().describe('The batch this one reproduces.'),
});

const batchRules =
  'progress.completed + progress.failed ≤ count, and = count when completed; progress.checkPassed + progress.checkFailed ≤ progress.completed; finishedAt is present exactly when status is completed or failed; rerunOf differs from id.';

export const batchSchema = batchObject
  .superRefine((batch, ctx) => {
    const done = batch.progress.completed + batch.progress.failed;
    if (
      done > batch.count ||
      (batch.status === 'completed' && done !== batch.count)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'progress does not fit count and status',
        path: ['progress'],
      });
    }
    if (
      batch.progress.checkPassed + batch.progress.checkFailed >
      batch.progress.completed
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'more self-checks than completed fixtures',
        path: ['progress'],
      });
    }
    const finished = batch.status === 'completed' || batch.status === 'failed';
    if (finished !== (batch.finishedAt !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'finishedAt is set exactly when the batch is completed or failed',
        path: ['finishedAt'],
      });
    }
    if (batch.rerunOf === batch.id) {
      ctx.addIssue({
        code: 'custom',
        message: 'a batch cannot rerun itself',
        path: ['rerunOf'],
      });
    }
  })
  .meta({
    title: 'Batch',
    description: `A batch and its progress. Not expressible in JSON Schema: ${batchRules}`,
  });

export type Batch = z.infer<typeof batchSchema>;

export const batchListSchema = z
  .strictObject({ batches: z.array(batchSchema) })
  .meta({
    title: 'Batch list',
    description: `Not expressible in JSON Schema: ${batchRules}`,
  });

export type BatchList = z.infer<typeof batchListSchema>;

const fixtureSchema = z
  .strictObject({
    index: z.int().min(0).describe('Index of the fixture in its batch.'),
    status: z.enum(['pending', 'completed', 'failed']),
    error: z.string().min(1).optional().describe('Why it failed.'),
    check: z
      .strictObject({ passed: z.boolean(), differences: z.int().min(0) })
      .optional()
      .describe('Self-check of the PDF against its gt.json.'),
  })
  .superRefine((fixture, ctx) => {
    if ((fixture.status === 'failed') !== (fixture.error !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'error is set exactly when the fixture failed',
        path: ['error'],
      });
    }
    if (fixture.check !== undefined && fixture.status !== 'completed') {
      ctx.addIssue({
        code: 'custom',
        message: 'only a completed fixture has a check',
        path: ['check'],
      });
    }
    if (fixture.check?.passed && fixture.check.differences !== 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a passed check has no differences',
        path: ['check', 'differences'],
      });
    }
  });

export type Fixture = z.infer<typeof fixtureSchema>;

/** The fixtures of one batch. */
export const fixtureListSchema = z
  .strictObject({ batchId, fixtures: z.array(fixtureSchema) })
  .superRefine((list, ctx) => {
    const seen = new Set<number>();
    list.fixtures.forEach((fixture, k) => {
      if (seen.has(fixture.index)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate index',
          path: ['fixtures', k, 'index'],
        });
      }
      seen.add(fixture.index);
    });
  })
  .meta({
    title: 'Fixture list',
    description:
      'The fixtures of one batch. Not expressible in JSON Schema: indexes are unique; error is present exactly when status is failed; check only when status is completed; a passed check has 0 differences.',
  });

export type FixtureList = z.infer<typeof fixtureListSchema>;
