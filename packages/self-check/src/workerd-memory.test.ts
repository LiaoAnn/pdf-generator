import { fileURLToPath } from 'node:url';
import { gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { maxNesting, maxOperations } from './operations.ts';

// The self-check runs in a Worker with 128 MB of memory (T14-10). workerd here
// gets the same cap as its V8 heap limit: past it, workerd dies and every
// later request fails with "Network connection lost". On main, T14-9's
// 300,000-rect repro did that; 480 nested groups took 36 s.

const heapLimitMb = 128;

let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const pdfs: Record<string, Uint8Array> = {};

const rects = (count: number) =>
  '<rect width="50" height="50" fill="#000000"/><rect width="50" height="50" fill="#000001"/>'.repeat(
    Math.floor(count / 2),
  ) + (count % 2 ? '<rect width="50" height="50"/>' : '');

const nestedGroups = (depth: number) =>
  `${Array.from({ length: depth }, (_, i) => `<g opacity="0.999"><rect width="50" height="50" fill="${i % 2 ? '#000001' : '#000000'}"/>`).join('')}${'</g>'.repeat(depth)}`;

const gt = gtSchema.parse({
  schemaVersion: 1,
  source: {
    templateId: 'workerd-memory',
    templateVersion: 1,
    seed: 'T14-10',
    index: 0,
  },
  pages: [{ width: 595.28, height: 841.89 }],
  blocks: [
    {
      id: 'title',
      type: 'title',
      page: 1,
      order: 0,
      text: 'Memory',
      bbox: [0, 0, 300, 30],
    },
  ],
});

// Miniflare reads the flag whenever it (re)starts workerd, not only at the
// start: keep it set for the whole file.
const previousFlags = process.env.MINIFLARE_WORKERD_V8_FLAGS;

/** The test worker in workerd with its V8 heap capped at `heapLimitMb`. */
async function startCapped() {
  process.env.MINIFLARE_WORKERD_V8_FLAGS = `--max-heap-size=${heapLimitMb}`;
  const started = await unstable_startWorker({
    entrypoint: fileURLToPath(import.meta.resolve('./test-worker.ts')),
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      persist: false,
    },
  });
  await started.url;
  return started;
}

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const print = async (svg: string) => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<style>@page{size:A4;margin:0}body{margin:0}</style>
          <h1 style="margin:0;height:30pt;font:20pt/30pt sans-serif">Memory</h1>
          <svg width="100pt" height="100pt" viewBox="0 0 100 100">${svg}</svg>`);
        return new Uint8Array(await page.pdf({ preferCSSPageSize: true }));
      } finally {
        await page.close();
      }
    };
    // T14-9 Security round 9: 300,000 overlapping rects.
    pdfs.rects = await print(rects(300_000));
    // T14-9 Security round 10, smaller: two trees nested past the cap.
    pdfs.groups = await print(nestedGroups(maxNesting * 2).repeat(2));
    // The most a document may still draw: rects up to an eighth of the
    // budget (each costs a handful of operators), and groups at the cap.
    pdfs.largest = await print(
      rects(Math.floor(maxOperations / 8)) + nestedGroups(maxNesting - 1),
    );
    pdfs.plain = await print('<rect width="10" height="10"/>');
  } finally {
    await browser.close();
  }
  worker = await startCapped();
}, 300_000);

afterAll(async () => {
  await worker?.dispose();
  if (previousFlags === undefined)
    delete process.env.MINIFLARE_WORKERD_V8_FLAGS;
  else process.env.MINIFLARE_WORKERD_V8_FLAGS = previousFlags;
});

async function check(pdf: Uint8Array | undefined) {
  if (!worker || !pdf) throw new Error('setup failed');
  const response = await worker.fetch('http://fixture.test/check', {
    method: 'POST',
    headers: { 'x-gt': JSON.stringify(gt) },
    body: pdf,
  });
  const body = await response.text();
  expect(response.status, body.slice(0, 500)).toBe(200);
  return JSON.parse(body) as {
    ok: boolean;
    differences: { kind: string; limit?: string }[];
  };
}

test('the workerd heap cap is real: holding twice the cap ends the request, holding half of it does not', async () => {
  // Guards the premise: without a working cap every case below could pass
  // for the wrong reason. A workerd past its cap stays dead: use a second one.
  const capped = await startCapped();
  try {
    const half = await capped.fetch(
      `http://fixture.test/allocate?mib=${heapLimitMb / 2}`,
      { method: 'POST' },
    );
    expect(half.status).toBe(200);
    const twice = await capped
      .fetch(`http://fixture.test/allocate?mib=${heapLimitMb * 2}`, {
        method: 'POST',
      })
      .then(
        response => response.status,
        () => 'failed',
      );
    expect(twice).not.toBe(200);
  } finally {
    await capped.dispose();
  }
  expect((await check(pdfs.plain)).ok).toBe(true);
});

test.each([
  ['300,000 overlapping rects (T14-9 round 9)', 'rects', 'operations'],
  ['groups nested twice past the cap (T14-9 round 10)', 'groups', 'nesting'],
] as const)(
  'under a 128 MB heap, the self-check refuses %s as unmeasurable and workerd keeps serving',
  async (_, name, limit) => {
    const report = await check(pdfs[name]);
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({ kind: 'unmeasurable', limit }),
    ]);
    expect((await check(pdfs.plain)).ok).toBe(true);
  },
);

test('under a 128 MB heap, the largest document the budget still admits is checked in full and workerd keeps serving', async () => {
  const report = await check(pdfs.largest);
  expect(
    report.differences.filter(difference => difference.kind === 'unmeasurable'),
  ).toEqual([]);
  expect((await check(pdfs.plain)).ok).toBe(true);
});
