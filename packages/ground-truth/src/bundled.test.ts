import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GroundTruth } from '@pdf-generator/contract';
import { build } from 'esbuild';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'bundled-reader-fixture',
  templateVersion: 1,
  seed: 'slice-2-bundled',
  index: 0,
};
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);
let browser: Browser;
let bundleDirectory: string;

beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(tmpdir(), 'ground-truth-bundle-'));
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
  }
});

describe('readGroundTruth from an esbuild Worker bundle', () => {
  test.each([false, true])(
    'matches unbundled ground truth with keepNames: true and minify: %s',
    async minify => {
      const bundlePath = join(bundleDirectory, `reader-${minify}.mjs`);
      const result = await build({
        entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        mainFields: ['module', 'main'],
        keepNames: true,
        minify,
        write: false,
      });
      const output = result.outputFiles[0];
      if (!output) throw new Error('esbuild produced no bundle');
      await writeFile(bundlePath, output.contents);
      const bundled = (await import(
        /* @vite-ignore */ pathToFileURL(bundlePath).href
      )) as Pick<typeof import('./index.ts'), 'readGroundTruth'>;

      const page = await browser.newPage();
      try {
        await page.setContent(`<!doctype html><html><head><style>
          @page { size: 600pt 800pt; margin: 60pt 48pt; }
          html, body { margin: 0; padding: 0; }
          h1, p { margin: 0; width: 240pt; height: 24pt; }
          body { font: 10pt/12pt sans-serif; }
          .next { break-before: page; }
        </style></head><body>
          <h1 data-gt="title" data-gt-id="report">Bundled report</h1>
          <p class="next" data-gt="paragraph" data-gt-id="summary">Second page</p>
        </body></html>`);
        await page.evaluate(`window.__pagedDone = false;
          window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
        await page.addScriptTag({ path: polyfill });
        await page.waitForFunction('window.__pagedDone === true');

        const expected: GroundTruth = {
          schemaVersion: 1,
          source,
          pages: [
            { width: 600, height: 800 },
            { width: 600, height: 800 },
          ],
          blocks: [
            {
              id: 'report',
              type: 'title',
              page: 1,
              bbox: [48, 60, 288, 84],
              order: 0,
              text: 'Bundled report',
            },
            {
              id: 'summary',
              type: 'paragraph',
              page: 2,
              bbox: [48, 60, 288, 84],
              order: 1,
              text: 'Second page',
            },
          ],
        };
        const unbundled = await readGroundTruth(page, source);
        expect(unbundled).toEqual(expected);
        const actual = await bundled.readGroundTruth(page, source);
        expect(actual).toEqual(unbundled);
        expect(actual).toEqual(expected);
      } finally {
        await page.close();
      }
    },
    60_000,
  );
});
