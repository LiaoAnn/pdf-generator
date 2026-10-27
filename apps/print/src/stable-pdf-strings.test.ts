import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { getDocumentProxy } from 'unpdf';
import { expect, test } from 'vitest';
import { stablePdf } from './stable-pdf.ts';
import { startPrintWorker } from './test-worker.ts';

const documentUrl =
  'http://127.0.0.1:46341/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/index.html';
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./test-fixtures/${name}.pdf`, import.meta.url)),
  );

test('Worker repeat prints preserve a title containing forged structure references and remain readable', async () => {
  const title =
    'Report /IDTree 31 0 R /IDTree 1 0 R /ID (node1) /Headers [(node2)] endobj stream endstream';
  const worker = await startPrintWorker('stable-strings');
  try {
    const prints: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await fetch(new URL('/print', (await worker.url).href), {
        method: 'POST',
        headers: {
          authorization: 'Bearer stable-strings',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          html: `<!doctype html><html lang="en"><head><title>${title}</title></head><body><p data-gt="paragraph" aria-label="${title}">Report</p></body></html>`,
          page: { size: 'A4', orientation: 'portrait' },
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      prints.push(bytes);
    }
    expect
      .soft(hash(prints[0] as Uint8Array))
      .toBe(hash(prints[1] as Uint8Array));
    for (const bytes of prints) {
      const pdf = await getDocumentProxy(bytes.slice());
      try {
        expect(pdf.numPages).toBe(1);
        expect((await pdf.getMetadata()).info).toMatchObject({ Title: title });
        expect(
          (await (await pdf.getPage(1)).getTextContent()).items.some(
            item => 'str' in item && item.str === 'Report',
          ),
        ).toBe(true);
      } finally {
        await pdf.loadingTask.destroy();
      }
    }
  } finally {
    await worker.dispose();
  }
});

// Small, xref-correct PDFs let the timing comparison vary only title bytes.
function pdfWithTitle(title: string, stream = ''): Uint8Array {
  // All test titles have balanced parentheses: retain nested literal strings
  // so the lexer is tested beyond Chrome's usual escaped-parenthesis form.
  const literal = title.replace(/\\/g, '\\\\');
  const bodies = [
    `<< /Title (${literal}) /CreationDate (D:20261027065851) /ModDate (D:20261027065851) >>`,
    '<< /Type /Catalog /Pages 3 0 R /StructTreeRoot 5 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 8 0 R >>',
    '<< /Type /StructTreeRoot /K [6 0 R] /IDTree 7 0 R >>',
    `<< /Type /StructElem /S /P /P 5 0 R /K 0 /ID (node9) /Alt (${literal}) >>`,
    '<< /Names [(node9) 6 0 R] >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, body] of bodies.entries()) {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  text += offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  text += `trailer\n<< /Size ${offsets.length} /Root 2 0 R /Info 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

test.each([
  'Report /IDTree 2 0 R',
  'Report /IDTree 1 0 R',
  'Report /ID (node1) /Headers [(node2)]',
  'endobj stream\n /IDTree 2 0 R endstream',
  'nested (one (two (three))) \\ /IDTree 2 0 R',
  '/CreationDate (D:19990101000000) /ModDate (D:19990101000000)',
  'trailer << /Info 2 0 R >> /IDTree 2 0 R',
])(
  'normalization preserves literal Title bytes and xref length: %s',
  async title => {
    const original = pdfWithTitle(title);
    const source = Buffer.from(original).toString('latin1');
    const start = source.indexOf('/Title ');
    const encodedTitle = `(${title.replace(/\\/g, '\\\\')})`;
    const end = start + '/Title '.length + encodedTitle.length;
    const normalized = stablePdf(original, documentUrl);
    expect.soft(normalized.length).toBe(original.length);
    expect
      .soft(
        Buffer.from(normalized)
          .subarray(start, end)
          .equals(Buffer.from(original).subarray(start, end)),
      )
      .toBe(true);
    expect
      .soft(Buffer.from(normalized).toString('latin1'))
      .toContain(`/Alt ${encodedTitle}`);
    const pdf = await getDocumentProxy(normalized.slice());
    try {
      const { info } = await pdf.getMetadata();
      expect(info).toMatchObject({ Title: title });
      expect(info).not.toHaveProperty('CreationDate');
      expect(info).not.toHaveProperty('ModDate');
      expect(pdf.numPages).toBe(1);
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);

test('stream payload containing endstream and forged objects cannot erase the catalog', () => {
  // The first endstream is payload, not the terminator: /Length defines it.
  const payload =
    '% endstream\n% /IDTree 2 0 R /ID (node1)\n% 99 0 obj\n% endobj\n';
  const original = pdfWithTitle('Stream report', payload);
  const source = Buffer.from(original).toString('latin1');
  const start = source.indexOf(payload);
  const normalized = stablePdf(original, documentUrl);
  expect(
    Buffer.from(normalized)
      .subarray(start, start + payload.length)
      .toString('latin1'),
  ).toBe(payload);
  expect(Buffer.from(normalized).toString('latin1')).toContain(
    '/Type /Catalog',
  );
});

test('3000 forged title references cost the same order of time as an equally long ordinary title', () => {
  const forged = Array.from(
    { length: 3000 },
    (_, i) => `/IDTree ${i + 100} 0 R`,
  ).join(' ');
  const inputs = [
    pdfWithTitle('x'.repeat(forged.length)),
    pdfWithTitle(forged),
  ];
  const samples: number[][] = [[], []];
  for (let round = 0; round < 13; round++) {
    // Alternate which input runs first; discard warmup, compare medians.
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const input = inputs[index] as Uint8Array;
      const start = performance.now();
      stablePdf(input, documentUrl);
      const elapsed = performance.now() - start;
      if (round > 1) samples[index]?.push(elapsed);
    }
  }
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
  const baseline = median(samples[0] as number[]);
  const forgedTime = median(samples[1] as number[]);
  expect(
    forgedTime,
    `forged median ${forgedTime}ms; baseline ${baseline}ms`,
  ).toBeLessThanOrEqual(5 * baseline + 3);
});

// Captured from unchanged T07-2 before writing these tests, not recomputed
// from the implementation under test. These catch compatibility drift.
test.each([
  [
    'untitled-print-a',
    'e5dedfa1780747d53e203f73426fc8deb2575e31fcd1c004586a7a4be2a45e42',
  ],
  [
    'untitled-print-b',
    'e5dedfa1780747d53e203f73426fc8deb2575e31fcd1c004586a7a4be2a45e42',
  ],
  [
    'titled-print',
    '8ff11ba3d43ad6796e4e8c1dc5f76306fb7a6ec59e40a700c4bdd5131cdebc4b',
  ],
  [
    'rerun-0-a',
    '663a040d01ed80a33efd8be5e40ead9611046f99c48ec3778d1e8835683c0d11',
  ],
  [
    'rerun-0-b',
    '663a040d01ed80a33efd8be5e40ead9611046f99c48ec3778d1e8835683c0d11',
  ],
  [
    'blank-1-pages',
    'aa1c38ee9119785fce8d015e6d3c3167d0563b9b631decfdb37a5610065598cb',
  ],
  [
    'blank-2-pages',
    'd5d534c051dd4c20d4e95914028895a4e910e48230478e3218f4d094ad047e12',
  ],
  [
    'blank-3-pages',
    '10950344c766299712e256d38b55ca3223012bb7e53f3e9c12a86b0f9bafc146',
  ],
  [
    'blank-7-pages',
    '27f4b0e683615e1734e4ad78ce7ea1f5e2950dbb8e915c6fb9657c5b84ccab23',
  ],
])('keeps T07-2 normalized fixture bytes: %s', (name, expected) => {
  const url =
    name === 'untitled-print-b'
      ? documentUrl.replace(
          '20b6a469-c5f1-487e-81c8-edc637db5b83',
          '02a98cb2-6739-4705-9392-1ca09ff51cdb',
        )
      : documentUrl;
  expect(hash(stablePdf(fixture(name), url))).toBe(expected);
});
