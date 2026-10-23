import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe('hand-authored multi-page fixture ground truth', () => {
  for (const name of ['monthly-report', 'incident-form']) {
    test(`${name} matches every hand-derived block after pagination`, async () => {
      const html = await readFile(
        new URL(`../fixtures/${name}.html`, import.meta.url),
        'utf8',
      );
      // Parse the independent oracle before the reader runs. These files must
      // never be regenerated from measurements or from readGroundTruth output.
      const expected = gtSchema.parse(
        JSON.parse(
          await readFile(
            new URL(`../fixtures/${name}.gt.json`, import.meta.url),
            'utf8',
          ),
        ),
      );
      const page = await browser.newPage();
      try {
        await page.setContent(html);
        await page.evaluate(`window.__pagedDone = false;
          window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
        await page.addScriptTag({ path: polyfill });
        // T03: the first page appearing is not completion; wait for after().
        await page.waitForFunction('window.__pagedDone === true');
        expect(await page.locator('.pagedjs_page').count()).toBe(
          expected.pages.length,
        );
        const result = await readGroundTruth(page, expected.source);
        expect(result).toEqual(expected);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
