import { readdir, readFile } from 'node:fs/promises';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { expect, test } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { platformFonts, selfChecker } from './check.ts';

const fontsDirectory = new URL('../../../print/public/fonts/', import.meta.url);

// nameID 6 is the PostScript name PDF readers keep after the subset tag.
function postScriptName(font: Uint8Array): string {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  let nameTable: Uint8Array | undefined;
  for (let index = 0; index < tables; index++) {
    const entry = 12 + 16 * index;
    const tag = String.fromCharCode(
      font[entry] ?? 0,
      font[entry + 1] ?? 0,
      font[entry + 2] ?? 0,
      font[entry + 3] ?? 0,
    );
    if (tag !== 'name') continue;
    const offset = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    nameTable = font.subarray(offset, offset + length);
  }
  if (!nameTable) throw new Error('font has no name table');
  const name = new DataView(
    nameTable.buffer,
    nameTable.byteOffset,
    nameTable.byteLength,
  );
  const count = name.getUint16(2);
  const stringOffset = name.getUint16(4);
  const found = new Set<string>();
  for (let index = 0; index < count; index++) {
    const base = 6 + 12 * index;
    const platformId = name.getUint16(base);
    const nameId = name.getUint16(base + 6);
    const length = name.getUint16(base + 8);
    const offset = name.getUint16(base + 10);
    if (nameId !== 6 || (platformId !== 0 && platformId !== 3)) continue;
    if (length % 2 !== 0) throw new Error('PostScript name is not UTF-16');
    const bytes = nameTable.subarray(
      stringOffset + offset,
      stringOffset + offset + length,
    );
    let text = '';
    for (let byte = 0; byte + 1 < bytes.length; byte += 2) {
      text += String.fromCharCode(
        ((bytes[byte] ?? 0) << 8) | (bytes[byte + 1] ?? 0),
      );
    }
    if (text !== '') found.add(text);
  }
  if (found.size !== 1) {
    throw new Error(
      `font has ${found.size} PostScript names: ${[...found].join(', ')}`,
    );
  }
  const [postScript] = found;
  if (!postScript) throw new Error('font has no PostScript name');
  return postScript;
}

test('platformFonts equals the PostScript names of the fonts the print Worker embeds', async () => {
  // Regression: a face added under apps/print/public/fonts but missing from
  // platformFonts makes every fixture's self-check report a font difference.
  const files = (await readdir(fontsDirectory))
    .filter(name => /\.(?:otf|ttf)$/i.test(name))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  const embedded = (
    await Promise.all(
      files.map(async file =>
        postScriptName(
          new Uint8Array(await readFile(new URL(file, fontsDirectory))),
        ),
      ),
    )
  ).sort();
  expect([...platformFonts].sort()).toEqual(embedded);
});

test('selfChecker rejects an unreadable PDF instead of reporting a pass', async () => {
  // Regression: a stub checker that always returns ok: true marks a PDF the
  // checker could not read as a passed fixture.
  const gt = gtSchema.parse(gtExample);
  await expect(
    selfChecker.check(new Uint8Array([1, 2, 3, 4]), gt),
  ).rejects.toThrow();
});

// A4 MediaBox. checkPdf allows 1 pt; these are the exact values both the PDF
// and gt.json use, so a size mismatch cannot hide a font result.
const pageWidth = 595.28;
const pageHeight = 841.89;

// 12 pt runs at y = 780 (PDF origin, bottom). Their ink stays inside the
// ground-truth box: baseline ≈ 61.89 pt from the top, width under 50 pt.
const textX = 36;
const textGap = 120;

const platformRun = 'Allowed';
const fallbackFont = 'Helvetica';
const fallbackRun = 'Outside';

function asciiPdf(objects: readonly string[]): Uint8Array {
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const startxref = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  for (const [id, offset] of offsets.entries()) {
    xref +=
      id === 0
        ? '0000000000 65535 f \n'
        : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** One page of WinAnsi Type 1 text. No embedded font program and no browser. */
function textInFonts(
  runs: readonly { font: string; text: string }[],
): Uint8Array {
  const stream = runs
    .map((run, index) => {
      const x = textX + index * textGap;
      return `BT /F${index + 1} 12 Tf ${x} 780 Td (${run.text}) Tj ET`;
    })
    .join('\n');
  const fonts = runs
    .map((_run, index) => `/F${index + 1} ${index + 5} 0 R`)
    .join(' ');
  const length = new TextEncoder().encode(stream).byteLength;
  return asciiPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    [
      '<< /Type /Page /Parent 2 0 R',
      `/MediaBox [0 0 ${pageWidth} ${pageHeight}]`,
      '/Contents 4 0 R',
      `/Resources << /Font << ${fonts} >> >> >>`,
    ].join(' '),
    `<< /Length ${length} >>\nstream\n${stream}\nendstream`,
    ...runs.map(
      run =>
        `<< /Type /Font /Subtype /Type1 /BaseFont /${run.font} /Encoding /WinAnsiEncoding >>`,
    ),
  ]);
}

function lineGroundTruth(text: string): GroundTruth {
  return gtSchema.parse({
    schemaVersion: 1,
    source: {
      templateId: 'font-allow-list',
      templateVersion: 1,
      seed: 'T16-font',
      index: 0,
    },
    pages: [{ width: pageWidth, height: pageHeight }],
    blocks: [
      {
        id: 'line',
        type: 'paragraph',
        page: 1,
        bbox: [20, 40, 560, 90],
        order: 0,
        text,
      },
    ],
  } satisfies GroundTruth);
}

test.each(platformFonts)(
  'selfChecker flags Helvetica and accepts text set in %s',
  async font => {
    // Regression: selfChecker must call checkPdf with platformFonts. Dropping
    // the fonts option leaves this PDF with no font difference, so the fixture
    // is stored as passed. Another list either allows Helvetica or flags this
    // platform face.
    expect(platformFonts).not.toContain(fallbackFont);
    const pdf = textInFonts([
      { font, text: platformRun },
      { font: fallbackFont, text: fallbackRun },
    ]);
    const report = await selfChecker.check(
      pdf,
      lineGroundTruth(platformRun + fallbackRun),
    );
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({
        kind: 'font',
        page: 1,
        font: fallbackFont,
        text: fallbackRun,
      }),
    ]);
  },
);
