import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import {
  apiErrorSchema,
  batchListSchema,
  batchRequestSchema,
  batchSchema,
  contractSchemas,
  fixtureListSchema,
  templateListSchema,
  templateSummarySchema,
} from './index.ts';

const timestamp = '2026-10-23T15:46:22.998Z';

function request(patch: Record<string, unknown> = {}) {
  return {
    templateId: 'monthly-report',
    templateVersion: 1,
    count: 2,
    seed: 'Seed_01-a',
    ...patch,
  };
}

function batch(patch: Record<string, unknown> = {}) {
  return {
    ...request(),
    id: 'Batch_01-a',
    status: 'running',
    progress: { completed: 1, failed: 0, checkPassed: 0, checkFailed: 0 },
    createdAt: timestamp,
    ...patch,
  };
}

function summary(patch: Record<string, unknown> = {}) {
  return {
    id: 'monthly-report',
    version: 1,
    name: '公司月報',
    page: { size: 'A4', orientation: 'portrait' },
    createdAt: timestamp,
    ...patch,
  };
}

function fixtures(...items: Record<string, unknown>[]) {
  return { batchId: 'Batch_01-a', fixtures: items };
}

function issuePaths(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map(issue => issue.path);
}

describe('API publication and transport boundaries', () => {
  test('registers every API decoder so published-schema compatibility checks cannot skip a body', () => {
    for (const [name, schema] of [
      ['api-error', apiErrorSchema],
      ['template-summary', templateSummarySchema],
      ['template-list', templateListSchema],
      ['batch-request', batchRequestSchema],
      ['batch', batchSchema],
      ['batch-list', batchListSchema],
      ['fixture-list', fixtureListSchema],
    ] as const) {
      expect(schema).toBeDefined();
      expect(contractSchemas).toHaveProperty(name, schema);
    }
  });

  test.each([1, 1000])(
    'accepts count %i at both inclusive batch limits',
    count => {
      for (const [schema, input] of [
        [batchRequestSchema, request({ count })],
        [batchSchema, batch({ count })],
      ] as const)
        expect(schema.parse(input)).toEqual(input);
    },
  );

  test.each([0, 1001, 1.5, '1'])(
    'rejects count %j that would bypass integer batch limits',
    count => {
      expect(batchRequestSchema.safeParse(request({ count })).success).toBe(
        false,
      );
      expect(batchSchema.safeParse(batch({ count })).success).toBe(false);
    },
  );

  test.each([
    '2026-10-23T15:46:22Z',
    '2026-10-23T15:46:22.9Z',
    '2026-10-23T15:46:22.99Z',
    timestamp,
    '2026-02-30T15:46:22Z',
  ])(
    'preserves UTC timestamp %s without imposing calendar validation',
    createdAt => {
      const template = summary({ createdAt });
      const finished = batch({
        status: 'failed',
        createdAt,
        finishedAt: createdAt,
      });
      expect(templateSummarySchema.parse(template)).toEqual(template);
      expect(batchSchema.parse(finished)).toEqual(finished);
    },
  );

  test.each([
    '2026-10-23T15:46:22+08:00',
    '2026-10-23T15:46:22+00:00',
    '2026-10-23T15:46:22',
    '2026-10-23T15:46:22.Z',
    '2026-10-23T15:46:22.9981Z',
    '2026-10-23 15:46:22Z',
    '2026-1-23T15:46:22Z',
    '2026-10-23T15:46:22Z\n',
  ])(
    'rejects noncanonical timestamp %j at every API timestamp field',
    value => {
      expect(
        templateSummarySchema.safeParse(summary({ createdAt: value })).success,
      ).toBe(false);
      expect(batchSchema.safeParse(batch({ createdAt: value })).success).toBe(
        false,
      );
      expect(
        batchSchema.safeParse(batch({ status: 'failed', finishedAt: value }))
          .success,
      ).toBe(false);
    },
  );

  test('rejects nested typos instead of silently dropping upload error metadata', () => {
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: 'invalid_template_pack',
          message: 'Invalid pack',
          details: [{ message: 'Bad rule', typo: true }],
        },
      }).success,
    ).toBe(false);
  });
});

describe('actionable upload error locations', () => {
  test('requires a line for a column and reports the offending detail column', () => {
    const detail = { message: 'Bad rule', column: 2 };
    const input = {
      error: {
        code: 'invalid_template_pack',
        message: 'Invalid pack',
        details: [detail],
      },
    };
    expect(issuePaths(apiErrorSchema, input)).toContainEqual([
      'error',
      'details',
      0,
      'column',
    ]);
    const located = {
      error: { ...input.error, details: [{ ...detail, line: 1 }] },
    };
    expect(apiErrorSchema.parse(located)).toEqual(located);
    const lineOnly = {
      error: { ...input.error, details: [{ message: 'Bad rule', line: 1 }] },
    };
    expect(apiErrorSchema.parse(lineOnly)).toEqual(lineOnly);
  });
});

describe('batch lifecycle invariants', () => {
  test('rejects self-check totals above completed even when print totals fit count', () => {
    // Regression: bounding checks by count (or failed + completed), or only
    // when the batch status is completed, accepts checks for fixtures that
    // never produced a completed PDF.
    const values = [
      ...[
        [2, 0],
        [0, 2],
        [1, 1],
      ].map(([checkPassed, checkFailed]) =>
        batch({
          progress: { completed: 1, failed: 1, checkPassed, checkFailed },
        }),
      ),
      batch({
        status: 'completed',
        finishedAt: timestamp,
        progress: { completed: 1, failed: 1, checkPassed: 1, checkFailed: 1 },
      }),
    ];
    for (const value of values) {
      for (const [schema, input, path] of [
        [batchSchema, value, ['progress']],
        [batchListSchema, { batches: [value] }, ['batches', 0, 'progress']],
      ] as const) {
        const result = schema.safeParse(input);
        expect.soft(result.success).toBe(false);
        if (!result.success)
          expect
            .soft(result.error.issues)
            .toContainEqual(expect.objectContaining({ code: 'custom', path }));
      }
    }
  });

  test('allows checks to cover some or all completed fixtures without requiring every PDF to have a check', () => {
    // Regression: treating missing legacy checks as invalid, using < instead
    // of <=, or copying the "done === count when completed" rule onto
    // self-check totals, rejects a partially checked batch.
    const values = [
      ...[
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [2, 0],
        [0, 2],
      ].map(([checkPassed, checkFailed]) =>
        batch({
          progress: { completed: 2, failed: 0, checkPassed, checkFailed },
        }),
      ),
      batch({
        status: 'completed',
        finishedAt: timestamp,
        progress: { completed: 1, failed: 1, checkPassed: 0, checkFailed: 0 },
      }),
    ];
    for (const value of values) {
      expect.soft(batchSchema.safeParse(value).success).toBe(true);
      expect
        .soft(batchListSchema.safeParse({ batches: [value] }).success)
        .toBe(true);
    }
  });

  test.each([
    ['queued', { completed: 2, failed: 1, checkPassed: 0, checkFailed: 0 }],
    ['running', { completed: 1, failed: 2, checkPassed: 0, checkFailed: 0 }],
    ['completed', { completed: 1, failed: 0, checkPassed: 0, checkFailed: 0 }],
    ['failed', { completed: 3, failed: 0, checkPassed: 0, checkFailed: 0 }],
  ])(
    'reports impossible %s progress on the batch and inside a batch list',
    (status, progress) => {
      const value = batch({
        status,
        progress,
        ...(['completed', 'failed'].includes(status)
          ? { finishedAt: timestamp }
          : {}),
      });
      expect(issuePaths(batchSchema, value)).toContainEqual(['progress']);
      expect(issuePaths(batchListSchema, { batches: [value] })).toContainEqual([
        'batches',
        0,
        'progress',
      ]);
    },
  );

  test('counts failed fixtures toward completion and allows an unfinished failed batch', () => {
    for (const value of [
      batch({
        status: 'completed',
        progress: { completed: 1, failed: 1, checkPassed: 0, checkFailed: 0 },
        finishedAt: timestamp,
      }),
      batch({
        status: 'failed',
        progress: { completed: 0, failed: 0, checkPassed: 0, checkFailed: 0 },
        finishedAt: timestamp,
      }),
      batch({
        progress: { completed: 1, failed: 1, checkPassed: 0, checkFailed: 0 },
      }),
    ])
      expect(batchSchema.parse(value)).toEqual(value);
  });

  test.each(['queued', 'running', 'completed', 'failed'])(
    'requires finishedAt exactly for terminal status %s',
    status => {
      const terminal = status === 'completed' || status === 'failed';
      const base = batch({
        status,
        progress: { completed: 1, failed: 1, checkPassed: 0, checkFailed: 0 },
      });
      const valid = { ...base, ...(terminal ? { finishedAt: timestamp } : {}) };
      const invalid = {
        ...base,
        ...(!terminal ? { finishedAt: timestamp } : {}),
      };
      expect(batchSchema.parse(valid)).toEqual(valid);
      expect(issuePaths(batchSchema, invalid)).toContainEqual(['finishedAt']);
    },
  );

  test('rejects self reruns while preserving a distinct source batch id', () => {
    expect(
      issuePaths(batchSchema, batch({ rerunOf: 'Batch_01-a' })),
    ).toContainEqual(['rerunOf']);
    const valid = batch({ rerunOf: 'Original_01' });
    expect(batchSchema.parse(valid)).toEqual(valid);
  });
});

describe('fixture result invariants', () => {
  test.each(['pending', 'completed', 'failed'])(
    'requires error exactly for failed fixtures: %s',
    status => {
      const terminalError = status === 'failed';
      const valid = fixtures({
        index: 0,
        status,
        ...(terminalError ? { error: 'Print failed' } : {}),
      });
      const invalid = fixtures({
        index: 0,
        status,
        ...(!terminalError ? { error: 'Print failed' } : {}),
      });
      expect(fixtureListSchema.parse(valid)).toEqual(valid);
      expect(issuePaths(fixtureListSchema, invalid)).toContainEqual([
        'fixtures',
        0,
        'error',
      ]);
    },
  );

  test.each(['pending', 'failed'])(
    'rejects a self-check attached to %s before a PDF exists',
    status => {
      const value = fixtures({
        index: 0,
        status,
        ...(status === 'failed' ? { error: 'Print failed' } : {}),
        check: { passed: false, differences: 1 },
      });
      expect(issuePaths(fixtureListSchema, value)).toContainEqual([
        'fixtures',
        0,
        'check',
      ]);
    },
  );

  test('reports a passing self-check with differences at differences and permits failed checks with zero differences', () => {
    const fixture = {
      index: 0,
      status: 'completed',
      check: { passed: true, differences: 1 },
    };
    expect(issuePaths(fixtureListSchema, fixtures(fixture))).toContainEqual([
      'fixtures',
      0,
      'check',
      'differences',
    ]);
    for (const check of [
      { passed: true, differences: 0 },
      { passed: false, differences: 0 },
      { passed: false, differences: 2 },
    ]) {
      const valid = fixtures({ ...fixture, check });
      expect(fixtureListSchema.parse(valid)).toEqual(valid);
    }
  });

  test('reports duplicate indexes on the later fixture without requiring contiguous or sorted indexes', () => {
    const first = { index: 7, status: 'pending' };
    const second = { index: 2, status: 'completed' };
    const valid = fixtures(first, second);
    expect(fixtureListSchema.parse(valid)).toEqual(valid);
    expect(
      issuePaths(fixtureListSchema, fixtures(first, second, first)),
    ).toContainEqual(['fixtures', 2, 'index']);
  });
});
