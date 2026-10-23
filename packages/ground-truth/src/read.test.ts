import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type EvaluatingPage,
  GroundTruthError,
  readGroundTruth,
} from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'reader-fixture',
  templateVersion: 1,
  seed: 'slice-2',
  index: 0,
};
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

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

async function paginate(page: Page, body: string, css = ''): Promise<void> {
  await page.setContent(`<!doctype html><html><head><style>
    @page { size: 600pt 800pt; margin: 60pt 48pt; }
    html, body { margin: 0; padding: 0; }
    * { box-sizing: border-box; }
    p, h1 { margin: 0; }
    body { font: 10pt/12pt sans-serif; }
    ${css}
    </style></head><body>${body}</body></html>`);
  await page.evaluate(`window.__pagedDone = false;
    window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
  await page.addScriptTag({ path: polyfill });
  // T03 §3: neither load nor the appearance of the first page is completion.
  await page.waitForFunction('window.__pagedDone === true');
}

async function expectReaderError(page: Page, message: RegExp): Promise<void> {
  try {
    await readGroundTruth(page, source);
  } catch (error) {
    // Let the stub's Error escape: RED must identify the missing implementation.
    if (!(error instanceof GroundTruthError)) throw error;
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.every(issue => typeof issue === 'string')).toBe(true);
    expect(error.issues.join('\n')).toMatch(message);
    return;
  }
  throw new Error('Expected readGroundTruth to reject the document');
}

describe('readGroundTruth on completed Paged.js pages', () => {
  test('reads a contract-valid two-page document using page-relative border boxes and rendered text', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<h1 data-gt="title" data-gt-id="report">Report</h1>
         <p data-gt="paragraph">  First<br>Second<span style="display:none">SECRET</span>  </p>
         <div style="display:none" data-gt="unknown-hidden">Hidden block</div>
         <p class="next" data-gt="paragraph">Last page</p>`,
        `h1 { width: 240pt; height: 36pt; padding: 6pt; border: 3pt solid black; }
         p { width: 300pt; height: 48pt; }
         .next { break-before: page; width: 180pt; height: 24pt; }`,
      );
      // Border-box sizing: title is 240 × 36 pt including its padding/border.
      // Page margins put it at (48, 60); the next block starts at 60 + 36.
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
            bbox: [48, 60, 288, 96],
            order: 0,
            text: 'Report',
          },
          {
            id: 'paragraph-1',
            type: 'paragraph',
            page: 1,
            bbox: [48, 96, 348, 144],
            order: 1,
            text: 'First\nSecond',
          },
          {
            id: 'paragraph-2',
            type: 'paragraph',
            page: 2,
            bbox: [48, 60, 228, 84],
            order: 2,
            text: 'Last page',
          },
        ],
      };
      // Passing a real Playwright Page also checks structural API compatibility.
      const result = await readGroundTruth(page, source);
      expect(result).toEqual(expected);
      expect(gtSchema.parse(result)).toEqual(expected);
    });
  }, 30_000);

  test('orders real running margin clones around body content on every page, including corners', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `${['tl', 'top', 'tr', 'left', 'right', 'bl', 'bottom', 'br']
          .map(
            name =>
              `<div class="${name}" data-gt="label" data-gt-id="${name}">${name}</div>`,
          )
          .join('')}
         <p data-gt="paragraph">Body one</p>
         <p class="next" data-gt="paragraph">Body two</p>`,
        `@page {
           @top-left-corner { content: element(tl); }
           @top-center { content: element(top); }
           @top-right-corner { content: element(tr); }
           @left-middle { content: element(left); }
           @right-middle { content: element(right); }
           @bottom-left-corner { content: element(bl); }
           @bottom-center { content: element(bottom); }
           @bottom-right-corner { content: element(br); }
         }
         ${['tl', 'top', 'tr', 'left', 'right', 'bl', 'bottom', 'br']
           .map(
             name =>
               `.${name} { position: running(${name}); width: 36pt; height: 12pt; }`,
           )
           .join('\n')}
         p { height: 24pt; } .next { break-before: page; }`,
      );
      const result = await readGroundTruth(page, source);
      expect(result.pages).toHaveLength(2);
      expect(
        result.blocks.map(({ text, page, order, id, continues }) => ({
          text,
          page,
          order,
          id,
          continues,
        })),
      ).toEqual(
        [1, 2].flatMap(page =>
          [
            'tl',
            'top',
            'tr',
            'left',
            `Body ${page === 1 ? 'one' : 'two'}`,
            'right',
            'bl',
            'bottom',
            'br',
          ].map((text, index) => ({
            text,
            page,
            order: (page - 1) * 9 + index,
            id: text.startsWith('Body')
              ? `paragraph-${page}`
              : `${text}${page === 1 ? '' : '-2'}`,
            continues: undefined,
          })),
        ),
      );
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('connects a genuinely split paragraph to its earlier fragment rather than emitting unrelated blocks', async () => {
    await withPage(async page => {
      // 200 - 2 × 60 = 80 pt available: four 18 pt lines, then two.
      // 18 pt is exactly 24 CSS px, avoiding fractional line-height snapping.
      await paginate(
        page,
        '<p data-gt="paragraph" data-gt-id="story">A<br>B<br>C<br>D<br>E<br>F</p>',
        `@page { size: 600pt 200pt; margin: 60pt 48pt; }
         p { width: 300pt; font-size: 10pt; line-height: 18pt; orphans: 1; widows: 1; }`,
      );
      const result = await readGroundTruth(page, source);
      expect(result.pages).toEqual([
        { width: 600, height: 200 },
        { width: 600, height: 200 },
      ]);
      expect(result.blocks).toEqual([
        {
          id: 'story',
          type: 'paragraph',
          page: 1,
          bbox: [48, 60, 348, 132],
          order: 0,
          text: 'A\nB\nC\nD',
        },
        {
          id: 'story-2',
          type: 'paragraph',
          page: 2,
          bbox: [48, 60, 348, 96],
          order: 1,
          text: 'E\nF',
          continues: 'story',
        },
      ]);
    });
  }, 30_000);

  test('evaluates only string expressions on the caller-owned page', async () => {
    await withPage(async page => {
      await paginate(
        page,
        '<p data-gt="paragraph" style="height:24pt">Same session</p>',
      );
      const expressions: string[] = [];
      const evaluatingPage: EvaluatingPage = {
        async evaluate(expression) {
          if (typeof expression !== 'string')
            throw new Error('Worker-unsafe function evaluation');
          expressions.push(expression);
          return page.evaluate(expression);
        },
      };
      const result = await readGroundTruth(evaluatingPage, source);
      expect(expressions.length).toBeGreaterThan(0);
      expect(result.blocks.map(block => block.text)).toEqual(['Same session']);
    });
  }, 30_000);

  test('passes options to detail readers after collecting browser measurements', async () => {
    await withPage(async page => {
      await paginate(
        page,
        '<div data-gt="checkbox" style="width:24pt;height:24pt">Yes</div>',
      );
      const result = await readGroundTruth(page, source, {
        detailReaders: {
          checkbox: measured => ({
            checked: measured.text === 'Yes' && measured.type === 'checkbox',
          }),
        },
      });
      expect(result.blocks).toEqual([
        {
          id: 'checkbox-1',
          type: 'checkbox',
          page: 1,
          bbox: [48, 60, 72, 84],
          order: 0,
          text: 'Yes',
          checked: true,
        },
      ]);
    });
  }, 30_000);

  test('rejects nested visible data-gt blocks instead of counting the same text twice', async () => {
    await withPage(async page => {
      await paginate(
        page,
        '<div data-gt="paragraph"><span data-gt="label">Nested</span></div>',
      );
      await expectReaderError(page, /nest/i);
    });
  }, 30_000);

  test('rejects plain HTML instead of measuring unpaginated screen coordinates', async () => {
    await withPage(async page => {
      await page.setContent('<p data-gt="paragraph">Not paginated</p>');
      await expectReaderError(page, /pagedjs_page/);
    });
  }, 30_000);

  test('rejects an unknown visible data-gt type rather than silently losing a printed block', async () => {
    await withPage(async page => {
      await paginate(page, '<div data-gt="unknown-widget">Printed</div>');
      await expectReaderError(page, /unknown-widget/);
    });
  }, 30_000);
});
