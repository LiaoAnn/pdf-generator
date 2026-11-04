import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';

// One page: a solid block both renderers draw alike, and CSS repeating-gradient
// stripes pdf.js draws solid or blank where PDFium draws stripes (T14-11).
// A second PDF holds an SVG radialGradient repeat at T06-12's probe
// position: about half ink in both renderers, but pdf.js scrambles the rings.
let directory: string;
let pdfPath: string;
let radialPath: string;

const block = (id: string, bbox: number[]) => ({
  id,
  type: 'image',
  page: 1,
  order: 0,
  text: '',
  bbox,
});
const gt = (blocks: ReturnType<typeof block>[]) => ({
  schemaVersion: 1,
  source: { templateId: 'cli', templateVersion: 1, seed: 'T14-11', index: 0 },
  pages: [{ width: 200, height: 100 }],
  blocks: blocks.map((value, order) => ({ ...value, order })),
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'compare-renderers-cli-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      @page { size: 200pt 100pt; margin: 0 }
      body { margin: 0 }
      i { position: absolute; display: block; print-color-adjust: exact }
    </style>
    <i style="left:20pt;top:20pt;width:40pt;height:20pt;background:black"></i>
    <i style="left:20pt;top:55pt;width:75pt;height:30pt;background:repeating-linear-gradient(90deg, black 0 2pt, transparent 2pt 4pt)"></i>`);
    pdfPath = join(directory, 'stripes.pdf');
    await writeFile(
      pdfPath,
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
    await page.setContent(`<!doctype html><style>
      @page { size: 400pt 300pt; margin: 0 }
      body { margin: 0 }
    </style>
    <i style="position:absolute;display:block;line-height:0;left:140pt;top:190pt"><svg viewBox="0 0 100 40" style="width:100px;height:40px;display:block"><defs><radialGradient id="r" r="0.04" spreadMethod="repeat"><stop offset="0" stop-color="black"/><stop offset="0.5" stop-color="black"/><stop offset="0.5" stop-color="white"/><stop offset="1" stop-color="white"/></radialGradient></defs><rect width="100" height="40" fill="url(#r)"/></svg></i>`);
    radialPath = join(directory, 'radial.pdf');
    await writeFile(
      radialPath,
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
  } finally {
    await browser.close();
  }
  await writeFile(
    join(directory, 'all.gt.json'),
    JSON.stringify(
      gt([
        block('solid', [20, 20, 60, 40]),
        block('stripes', [20, 55, 95, 85]),
      ]),
    ),
  );
  await writeFile(
    join(directory, 'radial.gt.json'),
    JSON.stringify({
      ...gt([block('radial-repeat', [140, 190, 215, 220])]),
      pages: [{ width: 400, height: 300 }],
    }),
  );
  await writeFile(
    join(directory, 'solid.gt.json'),
    JSON.stringify(gt([block('solid', [20, 20, 60, 40])])),
  );
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./compare-renderers-cli.ts', import.meta.url)),
          ...args,
        ],
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

test('lists every block with both ink shares and the position, and exits 1 when a block differs', async () => {
  const { code, stdout, stderr } = await runCli([
    pdfPath,
    '--gt',
    join(directory, 'all.gt.json'),
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(1);
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(
    /^solid p1 pdf\.js (0\.9\d|1\.00) PDFium (0\.9\d|1\.00) position 0\.0\d agree$/,
  );
  expect(lines[1]).toMatch(
    /^stripes p1 pdf\.js (0|1)\.\d\d PDFium 0\.[45]\d position 0\.[3-9]\d DIFFERS$/,
  );
  expect(lines[2]).toBe('blocks: 1/2 agree');
});

test('a block whose ink shares agree but whose ink is elsewhere differs', async () => {
  const { code, stdout, stderr } = await runCli([
    radialPath,
    '--gt',
    join(directory, 'radial.gt.json'),
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(1);
  const [line, summary] = stdout.trim().split('\n');
  const match = line?.match(
    /^radial-repeat p1 pdf\.js (\d\.\d\d) PDFium (\d\.\d\d) position (\d\.\d\d) DIFFERS$/,
  );
  expect(match).not.toBeNull();
  const [, pdfjs, pdfium, position] = (match ?? []).map(Number);
  expect(Math.abs((pdfjs ?? 0) - (pdfium ?? 0))).toBeLessThan(0.1);
  expect(position).toBeGreaterThan(0.15);
  expect(summary).toBe('blocks: 0/1 agree');
});

test('exits 0 when every block agrees', async () => {
  const { code, stdout } = await runCli([
    pdfPath,
    '--gt',
    join(directory, 'solid.gt.json'),
  ]);
  expect(code).toBe(0);
  expect(stdout.trim().split('\n').at(-1)).toBe('blocks: 1/1 agree');
});

test('--threshold widens agreement', async () => {
  const { code, stdout } = await runCli([
    pdfPath,
    '--gt',
    join(directory, 'all.gt.json'),
    '--threshold',
    '1',
  ]);
  expect(code).toBe(0);
  expect(stdout.trim().split('\n').at(-1)).toBe('blocks: 2/2 agree');
});

test('--out writes each page as drawn by both renderers, at --scale', async () => {
  const out = join(directory, 'out');
  const { code } = await runCli([
    pdfPath,
    '--gt',
    join(directory, 'all.gt.json'),
    '--out',
    out,
    '--scale',
    '2',
  ]);
  expect(code).toBe(1);
  expect((await readdir(out)).sort()).toEqual([
    'stripes-p1.pdfium.png',
    'stripes-p1.pdfjs.png',
  ]);
  for (const name of await readdir(out)) {
    const bytes = await readFile(join(out, name));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(Math.abs(bytes.readUInt32BE(16) - 400)).toBeLessThanOrEqual(1);
  }
});

test.each([
  ['no gt.json', () => [pdfPath]],
  [
    'a missing PDF',
    () => [join(directory, 'none.pdf'), '--gt', join(directory, 'all.gt.json')],
  ],
  ['an invalid gt.json', () => [pdfPath, '--gt', pdfPath]],
  [
    'a bad scale',
    () => [pdfPath, '--gt', join(directory, 'all.gt.json'), '--scale', '0'],
  ],
  [
    'a bad threshold',
    () => [
      pdfPath,
      '--gt',
      join(directory, 'all.gt.json'),
      '--threshold',
      '-1',
    ],
  ],
])('exits 2 with the usage for %s', async (_case, args) => {
  const { code, stdout, stderr } = await runCli(args());
  expect(code).toBe(2);
  expect(stdout).toBe('');
  expect(stderr).toContain(
    'usage: node packages/dev-tools/src/compare-renderers-cli.ts',
  );
});
