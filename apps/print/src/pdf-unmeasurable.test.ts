// T07-33: since T14-10, `missingText` refuses a PDF over the self-check's
// document budget (operators, group nesting, decoded content) with
// `UnmeasurablePdfError`. The print Worker let it escape, so a pack with
// data-gt text whose PDF the platform can't measure got a 500 from /print.
// It is a property of the pack, so it is refused as 422 pdf_unmeasurable.
import { apiErrorSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'pdf-unmeasurable-local-test';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

// The self-check refuses groups nested past 64 (T14-10's maxNesting); Chrome
// writes each SVG opacity group as a nested transparency group.
const depth = 80;
const nestedGroups = `${Array.from(
  { length: depth },
  (_, i) =>
    `<g opacity="0.999"><rect width="50" height="50" fill="${i % 2 ? '#000001' : '#000000'}"/>`,
).join('')}${'</g>'.repeat(depth)}`;

const html = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<style>
@page { size: A4; margin: 20mm; }
body { margin: 0; font: 16px/24px "Noto Sans TC"; }
</style></head><body>
<p data-gt="paragraph">量測上限的前文。</p>
<div data-gt="image" data-gt-id="figure" style="width:100pt;height:100pt">
<svg width="100pt" height="100pt" viewBox="0 0 100 100">${nestedGroups.repeat(2)}</svg>
</div></body></html>`;

// Regression: the nesting refusal escaped renderPdf and /print answered 500.
test('a PDF with groups nested past the budget is refused as pdf_unmeasurable', async () => {
  const response = await fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
    }),
  });
  expect(
    response.status,
    response.status === 200
      ? 'unexpected PDF success: the unmeasurable PDF was printed'
      : await response.clone().text(),
  ).toBe(422);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('pdf_unmeasurable');
  // The self-check's own reason, so the author sees which limit it was.
  expect(error.details).toHaveLength(1);
  expect(error.details?.[0]?.message).toContain('nesting past 64');
});
