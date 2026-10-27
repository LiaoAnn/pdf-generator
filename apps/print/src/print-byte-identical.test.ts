import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { gtSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'byte-identical-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

// Each case catches returning Chrome's per-print metadata (dates and the
// fallback pack URL) or session-dependent tagged-PDF DOM node ids. Three
// prints cover two fresh browsers and reuse without a separate pair per mode.
test.each([
  { shape: 'PDF body', withSource: false, title: 'without title', head: '' },
  {
    shape: 'PDF body',
    withSource: false,
    title: 'with title',
    head: '<title>Monthly report</title>',
  },
  { shape: 'JSON pdf', withSource: true, title: 'without title', head: '' },
  {
    shape: 'JSON pdf',
    withSource: true,
    title: 'with title',
    head: '<title>Monthly report</title>',
  },
])(
  '$shape $title excludes per-print metadata and session-dependent node ids from its SHA-256',
  async ({ withSource, head }) => {
    const body = JSON.stringify({
      html: `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">${head}
        <style>body { font: 16px "Noto Sans TC"; }</style></head><body>
        <h1 data-gt="title">公司月報</h1>
        <p data-gt="paragraph">本月營收新臺幣一百萬元。</p></body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      ...(withSource
        ? {
            source: {
              templateId: 'monthly-report',
              templateVersion: 1,
              seed: 'byte-identical_42',
              index: 0,
            },
          }
        : {}),
    });
    const sessions = new Set<string>();
    async function print(session: string) {
      const response = await fetch(new URL('/print', (await worker.url).href), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Browser-Session': session,
        },
        body,
      });
      const id = response.headers.get('X-Browser-Session');
      if (id) sessions.add(id);
      expect(response.status, 'print must succeed before comparing PDFs').toBe(
        200,
      );
      expect(
        id,
        'caller must be able to reuse and close the browser',
      ).toBeTruthy();
      let bytes: Buffer;
      if (withSource) {
        expect(response.headers.get('content-type')).toMatch(
          /^application\/json\b/i,
        );
        const result = (await response.json()) as {
          pdf: string;
          gt: unknown;
          pageCount: number;
        };
        expect(result.pageCount).toBe(1);
        expect(
          gtSchema.parse(result.gt).blocks.map(block => block.text),
        ).toEqual(['公司月報', '本月營收新臺幣一百萬元。']);
        bytes = Buffer.from(result.pdf, 'base64');
      } else {
        expect(response.headers.get('content-type')).toMatch(
          /^application\/pdf\b/i,
        );
        bytes = Buffer.from(await response.arrayBuffer());
      }
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      return {
        id: id ?? 'missing-session',
        hash: createHash('sha256').update(bytes).digest('hex'),
      };
    }

    try {
      const first = await print('new');
      // Chrome's PDF date resolution is one second. Make a missing date
      // normalization observable even if all three prints become very fast.
      await setTimeout(1_100);
      const fresh = await print('new');
      expect(fresh.id, 'new must create a different browser').not.toBe(
        first.id,
      );
      const reused = await print(fresh.id);
      expect(reused.id, 'the third print must actually reuse the browser').toBe(
        fresh.id,
      );
      expect
        .soft(fresh.hash, 'two fresh browsers must return identical PDF bytes')
        .toBe(first.hash);
      expect
        .soft(reused.hash, 'reusing a browser must return identical PDF bytes')
        .toBe(fresh.hash);
    } finally {
      for (const id of sessions) {
        const response = await fetch(
          new URL(`/session/${id}`, (await worker.url).href),
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        expect.soft(response.status, 'kept browser must be closed').toBe(204);
      }
    }
  },
);
