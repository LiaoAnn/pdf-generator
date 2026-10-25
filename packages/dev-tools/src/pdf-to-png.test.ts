import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { pdfToPng } from './index.ts';

let browser: Browser;
let directory: string;
let a4: Uint8Array;
let custom: Uint8Array;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pdf-to-png-test-'));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    // Positions are in PDF points, independent of the rasterizer under test.
    await page.setContent(`<style>
      @page { margin: 0; }
      body { margin: 0; }
      section { position: relative; height: 150pt; }
      section + section { break-before: page; }
      i { position: absolute; top: 30pt; width: 40pt; height: 40pt;
          background: black; print-color-adjust: exact; }
    </style>
    <section><i style="left: 30pt"></i></section>
    <section><i style="left: 130pt"></i></section>`);
    a4 = await page.pdf({ format: 'A4', printBackground: true });
    custom = await page.pdf({
      width: '320px',
      height: '480px',
      printBackground: true,
    });
  } finally {
    await page.close();
  }
});

afterAll(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./cli.ts', import.meta.url)), ...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', text => {
        stdout += text;
      });
      child.stderr.setEncoding('utf8').on('data', text => {
        stderr += text;
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    },
  );
}

async function expectPages(
  pngs: Uint8Array[],
  width: number,
  height: number,
  scale: number,
) {
  expect(pngs).toHaveLength(2);
  const page = await browser.newPage();
  try {
    for (const [index, png] of pngs.entries()) {
      const bytes = Buffer.from(png);
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(
        Math.abs(bytes.readUInt32BE(16) - width * scale),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(bytes.readUInt32BE(20) - height * scale),
      ).toBeLessThanOrEqual(1);
      const pixels = await page.evaluate(
        async ({ base64, scale }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('2D canvas unavailable');
          context.drawImage(image, 0, 0);
          return [
            [50, 50],
            [150, 50],
            [100, 120],
          ].map(([x, y]) =>
            Array.from(
              context.getImageData(
                Math.round((x ?? 0) * scale),
                Math.round((y ?? 0) * scale),
                1,
                1,
              ).data,
            ),
          );
        },
        { base64: bytes.toString('base64'), scale },
      );
      // The squares swap positions between pages; blank, repeated, reversed,
      // transparent, or shifted pages must fail as well as wrong dimensions.
      expect(pixels).toEqual(
        index === 0
          ? [
              [0, 0, 0, 255],
              [255, 255, 255, 255],
              [255, 255, 255, 255],
            ]
          : [
              [255, 255, 255, 255],
              [0, 0, 0, 255],
              [255, 255, 255, 255],
            ],
      );
    }
  } finally {
    await page.close();
  }
}

test('CLI writes every A4 page beside the PDF at default scale, with ordered names and visible content', async () => {
  // Chromium's A4 dimensions vary; use the MediaBoxes in this fixture,
  // independently of the rasterizer under test.
  const mediaBoxes = Array.from(
    Buffer.from(a4)
      .toString('latin1')
      .matchAll(/\/MediaBox\s*\[([^\]]+)\]/g),
    match => (match[1] ?? '').trim().split(/\s+/).map(Number),
  );
  expect(mediaBoxes).toHaveLength(2);
  const [left, bottom, right, top] = mediaBoxes[0] ?? [];
  if (
    left === undefined ||
    bottom === undefined ||
    right === undefined ||
    top === undefined
  ) {
    throw new Error('A4 fixture must declare its MediaBox');
  }
  for (const box of mediaBoxes) {
    expect(box).toEqual([left, bottom, right, top]);
  }
  const width = right - left;
  const height = top - bottom;
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  const inputDirectory = await mkdtemp(join(directory, 'default-'));
  const input = join(inputDirectory, 'monthly report.pdf');
  await writeFile(input, a4);
  const result = await runCli([input]);
  expect(result.code, result.stderr).toBe(0);
  const paths = [1, 2].map(number =>
    join(inputDirectory, `monthly report-p${number}.png`),
  );
  expect(result.stdout.trim().split(/\r?\n/)).toEqual(paths);
  expect((await readdir(inputDirectory)).sort()).toEqual([
    'monthly report-p1.png',
    'monthly report-p2.png',
    'monthly report.pdf',
  ]);
  await expectPages(
    await Promise.all(paths.map(path => readFile(path))),
    width,
    height,
    2,
  );
});

test('CLI honors --out and fractional --scale for non-A4 pages', async () => {
  const inputDirectory = await mkdtemp(join(directory, 'explicit-'));
  const input = join(inputDirectory, 'custom.pdf');
  const output = join(inputDirectory, 'new output');
  await writeFile(input, custom);
  const result = await runCli([input, '--out', output, '--scale', '0.75']);
  expect(result.code, result.stderr).toBe(0);
  const paths = [1, 2].map(number => join(output, `custom-p${number}.png`));
  expect(result.stdout.trim().split(/\r?\n/)).toEqual(paths);
  expect((await readdir(output)).sort()).toEqual([
    'custom-p1.png',
    'custom-p2.png',
  ]);
  expect(await readdir(inputDirectory)).toEqual(
    expect.not.arrayContaining(['custom-p1.png']),
  );
  await expectPages(
    await Promise.all(paths.map(path => readFile(path))),
    240,
    360,
    0.75,
  );
});

test('public library returns ordered PNG bytes with default and explicit scales', async () => {
  await expectPages(await pdfToPng(custom), 240, 360, 2);
  await expectPages(await pdfToPng(custom, { scale: 1.25 }), 240, 360, 1.25);
});

test.each(['missing argument', 'missing file', 'invalid PDF'])(
  'CLI rejects %s with a diagnostic and no PNG output',
  async kind => {
    const output = await mkdtemp(join(directory, 'invalid-'));
    const input = join(output, 'invalid.pdf');
    if (kind === 'invalid PDF') await writeFile(input, 'this is not a PDF');
    const args = kind === 'missing argument' ? [] : [input];
    const result = await runCli([...args, '--out', output]);
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
    expect(result.stdout.trim()).toBe('');
    expect(
      (await readdir(output)).filter(name => name.endsWith('.png')),
    ).toEqual([]);
  },
);

test('public library rejects non-PDF bytes instead of returning an empty or blank result', async () => {
  await expect(
    pdfToPng(new TextEncoder().encode('not a PDF')),
  ).rejects.toThrow();
});
