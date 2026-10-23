import { readFile } from 'node:fs/promises';
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

// Keep error assertions at the public boundary: a generic missing-reader error
// must not masquerade as validation of a particular markup problem.
async function expectMarkupIssues(
  page: Page,
  problems: { id: string; problem: RegExp }[],
): Promise<void> {
  const error = await readGroundTruth(page, source).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(GroundTruthError);
  if (!(error instanceof GroundTruthError)) return;
  expect(error.issues.every(issue => typeof issue === 'string')).toBe(true);
  for (const { id, problem } of problems) {
    expect
      .soft(
        error.issues.some(issue => issue.includes(id) && problem.test(issue)),
        `Missing issue for ${id}: ${problem}; received ${error.issues.join('; ')}`,
      )
      .toBe(true);
  }
}

describe('T13 checkbox state and markup validation', () => {
  test('reads live checked properties after script changes instead of stale checked attributes', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div data-gt="checkbox" data-gt-id="script-on"><input type="checkbox">同意</div>
         <input data-gt="checkbox" data-gt-id="script-off" type="radio" checked>`,
        '[data-gt] { display: block; width: 120pt; height: 24pt; margin: 0; }',
      );
      // Change the printed clones, after pagination, in the caller's session.
      await page.evaluate(`
        document.querySelector('.pagedjs_page [data-gt-id="script-on"] input').checked = true;
        document.querySelector('.pagedjs_page [data-gt-id="script-off"]').checked = false;
      `);
      const result = await readGroundTruth(page, source);
      expect(gtSchema.parse(result)).toEqual(result);
      expect(
        result.blocks.map(block => ({
          id: block.id,
          text: block.text,
          checked: block.type === 'checkbox' ? block.checked : undefined,
        })),
      ).toEqual([
        { id: 'script-on', text: '同意', checked: true },
        { id: 'script-off', text: '', checked: false },
      ]);
    });
  }, 30_000);

  test('ignores non-choice inputs when finding the single checkbox or radio', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div data-gt="checkbox" data-gt-id="mixed-inputs"><input type="text" value="note"><input type="radio" checked>是</div>`,
        '[data-gt] { height: 24pt; }',
      );
      const result = await readGroundTruth(page, source);
      expect(result.blocks[0]).toMatchObject({
        id: 'mixed-inputs',
        text: '是',
        checked: true,
      });
    });
  }, 30_000);

  test.each(['', 'TRUE', '1', 'yes'])(
    'rejects invalid data-gt-checked=%j rather than coercing it to a boolean',
    async value => {
      await withPage(async page => {
        await paginate(
          page,
          `<div data-gt="checkbox" data-gt-id="invalid-state" data-gt-checked="${value}"><input type="checkbox">同意</div>`,
        );
        await expectMarkupIssues(page, [
          { id: 'invalid-state', problem: /data-gt-checked/ },
        ]);
      });
    },
    30_000,
  );

  test.each([
    { attribute: 'true', input: '<input type="checkbox">' },
    { attribute: 'false', input: '<input type="radio" checked>' },
  ])(
    'rejects explicit $attribute when the input disagrees',
    async ({ attribute, input }) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div data-gt="checkbox" data-gt-id="state-pair" data-gt-checked="${attribute}">${input}同意</div>`,
        );
        await expectMarkupIssues(page, [
          { id: 'state-pair', problem: /disagree|conflict|mismatch/i },
        ]);
      });
    },
    30_000,
  );

  test.each([
    { name: 'a printed symbol alone', content: '☑ 同意' },
    { name: 'a text input', content: '<input type="text">同意' },
  ])(
    'rejects $name without a declared state',
    async ({ content }) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div data-gt="checkbox" data-gt-id="no-state">${content}</div>`,
        );
        await expectMarkupIssues(page, [
          {
            id: 'no-state',
            problem:
              /no.*input|missing.*(state|checked|input)|single.*input|exactly one|cannot determine/i,
          },
        ]);
      });
    },
    30_000,
  );

  test('rejects multiple choice inputs rather than taking the first checked state', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div data-gt="checkbox" data-gt-id="ambiguous"><input type="checkbox" checked><input type="radio">同意</div>`,
      );
      await expectMarkupIssues(page, [
        {
          id: 'ambiguous',
          problem: /multiple|more than one|single.*input|exactly one|2.*input/i,
        },
      ]);
    });
  }, 30_000);

  test.each([
    {
      type: 'checkbox',
      attribute: 'data-gt-cheked',
      extra: 'data-gt-checked="true"',
    },
    { type: 'field', attribute: 'data-gt-checked', extra: '' },
    { type: 'paragraph', attribute: 'data-gt-latex', extra: '' },
    { type: 'label', attribute: 'data-gt-text', extra: '' },
  ])(
    'rejects $attribute on $type instead of silently accepting bad markup',
    async ({ type, attribute, extra }) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div data-gt="${type}" data-gt-id="bad-attribute" ${attribute}="true" ${extra}>Printed</div>`,
        );
        await expectMarkupIssues(page, [
          { id: 'bad-attribute', problem: new RegExp(attribute) },
        ]);
      });
    },
    30_000,
  );

  test('reports every bad attribute on one block and problems on later blocks in one GroundTruthError', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div data-gt="field" data-gt-id="bad-field" data-gt-checked="false" data-gt-cheked="false">Printed</div>
         <div data-gt="label" data-gt-id="bad-label" data-gt-text="secret" data-gt-latex="x">Label</div>
         <div data-gt="checkbox" data-gt-id="bad-checkbox" data-gt-checked="maybe">同意</div>`,
      );
      await expectMarkupIssues(page, [
        { id: 'bad-field', problem: /data-gt-checked/ },
        { id: 'bad-field', problem: /data-gt-cheked/ },
        { id: 'bad-label', problem: /data-gt-text/ },
        { id: 'bad-label', problem: /data-gt-latex/ },
        { id: 'bad-checkbox', problem: /data-gt-checked/ },
      ]);
    });
  }, 30_000);
});

describe('T13 formula sources and declared image text', () => {
  test.each([
    {
      name: 'missing LaTeX rather than inferring it from visible glyphs',
      attributes: '',
      content: '<span class="katex-html">x²</span>',
      problem:
        /(?:missing|no|needs|requires?|provide|add).*(?:latex|source|annotation)|(?:latex|source).*(?:missing|empty|required)/i,
    },
    {
      name: 'an empty explicit LaTeX attribute',
      attributes: 'data-gt-latex=""',
      content: 'x',
      problem: /empty|non.?empty|blank/i,
    },
    {
      name: 'whitespace-only explicit LaTeX even when an annotation is usable',
      attributes: 'data-gt-latex="   "',
      content:
        '<math><semantics><annotation encoding="application/x-tex">x</annotation></semantics></math>',
      problem: /empty|non.?empty|blank|disagree|conflict|mismatch/i,
    },
    {
      name: 'an empty annotation after trimming',
      attributes: '',
      content:
        '<math><semantics><annotation encoding="application/x-tex">   </annotation></semantics></math>',
      problem: /empty|non.?empty|blank/i,
    },
    {
      name: 'a non-TeX annotation rather than treating arbitrary metadata as LaTeX',
      attributes: '',
      content:
        '<math><semantics><annotation encoding="text/plain">x</annotation></semantics></math>',
      problem:
        /(?:missing|no|needs|requires?|provide|add).*(?:latex|source|annotation)|(?:latex|source).*(?:missing|empty|required)/i,
    },
    {
      name: 'disagreeing attribute and annotation rather than silently preferring the attribute',
      attributes: 'data-gt-latex=" x "',
      content:
        '<math><semantics><annotation encoding="application/x-tex"> y </annotation></semantics></math>',
      problem: /disagree|conflict|mismatch/i,
    },
    {
      name: 'multiple distinct annotations without an explicit source',
      attributes: '',
      content:
        '<math><semantics><annotation encoding="application/x-tex">x</annotation><annotation encoding="application/x-tex">y</annotation></semantics></math>',
      problem:
        /multiple|more than one|ambiguous|exactly one|single.*annotation|2.*annotation/i,
    },
    {
      name: 'duplicate equal annotations without an explicit source rather than deduplicating ambiguity',
      attributes: '',
      content:
        '<math><semantics><annotation encoding="application/x-tex">x</annotation><annotation encoding="application/x-tex">x</annotation></semantics></math>',
      problem:
        /multiple|more than one|ambiguous|exactly one|single.*annotation|2.*annotation/i,
    },
  ])(
    'rejects $name',
    async ({ attributes, content, problem }) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div data-gt="formula" data-gt-id="invalid-formula" ${attributes}>${content}</div>`,
          '[data-gt] { width: 240pt; height: 36pt; }',
        );
        await expectMarkupIssues(page, [{ id: 'invalid-formula', problem }]);
      });
    },
    30_000,
  );

  test.each([
    { name: 'different declared and rendered text', declared: 'Declared' },
    { name: 'equal declared and rendered text', declared: 'Printed' },
    { name: 'an empty declaration alongside rendered text', declared: '   ' },
  ])(
    'rejects an image with $name rather than choosing one source',
    async ({ declared }) => {
      await withPage(async page => {
        await paginate(
          page,
          `<div data-gt="image" data-gt-id="image-case" data-gt-text="${declared}">Printed</div>`,
          '[data-gt] { width: 240pt; height: 48pt; }',
        );
        await expectMarkupIssues(page, [
          {
            id: 'image-case',
            problem:
              /(?:data-gt-text|declared).*(?:rendered|visible|innerText|non.?empty|text content)|(?:rendered|visible|innerText).*(?:data-gt-text|declared)|two.*sources/i,
          },
        ]);
      });
    },
    30_000,
  );

  test('reports formula ambiguity, source disagreement and image text conflicts together rather than stopping at the first block', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div data-gt="formula" data-gt-id="formula-a"><math><semantics><annotation encoding="application/x-tex">x</annotation><annotation encoding="application/x-tex">y</annotation></semantics></math></div>
         <div data-gt="formula" data-gt-id="formula-b" data-gt-latex="x"><math><semantics><annotation encoding="application/x-tex">y</annotation></semantics></math></div>
         <div data-gt="image" data-gt-id="image-c" data-gt-text="Declared">Printed</div>`,
        '[data-gt] { width: 240pt; height: 48pt; }',
      );
      await expectMarkupIssues(page, [
        {
          id: 'formula-a',
          problem:
            /multiple|more than one|ambiguous|exactly one|single.*annotation|2.*annotation/i,
        },
        { id: 'formula-b', problem: /disagree|conflict|mismatch/i },
        {
          id: 'image-c',
          problem:
            /(?:data-gt-text|declared).*(?:rendered|visible|innerText|non.?empty|text content)|(?:rendered|visible|innerText).*(?:data-gt-text|declared)|two.*sources/i,
        },
      ]);
    });
  }, 30_000);
});

describe('T13 single-page table grid boundaries and markup errors', () => {
  const tableCss = `table { table-layout: fixed; border-collapse: separate; border-spacing: 0; width: 180pt; }
    tr { height: 24pt; } td, th { padding: 0; border: 0; }`;

  test.each([
    { name: 'rowspan zero extends to the last row', span: 0 },
    { name: 'an oversized rowspan is clipped to the last row', span: 99 },
  ])(
    '$name without emitting covered slots as cells',
    async ({ span }) => {
      await withPage(async page => {
        await paginate(
          page,
          `<table data-gt="table" data-gt-id="span-edge">
            <colgroup><col style="width:60pt"><col style="width:60pt"><col style="width:60pt"></colgroup>
            <tbody><tr><td>First</td><td rowspan="${span}">Tall</td><td>Right</td></tr>
            <tr><td>Left 2</td><td>Right 2</td></tr>
            <tr><td>Left 3</td><td>Right 3</td></tr></tbody>
          </table>`,
          tableCss,
        );
        const result = await readGroundTruth(page, source);
        expect(result.pages).toHaveLength(1);
        expect(result.blocks).toHaveLength(1);
        const block = result.blocks[0];
        expect(block?.type).toBe('table');
        if (block?.type !== 'table') return;
        // Margins (48,60), 60pt columns, 24pt rows. The spanning cell
        // occupies the middle column: later cells must skip it, not just
        // append after the last occupied column or use their DOM index.
        expect(block.table).toEqual({
          rows: 3,
          cols: 3,
          cells: [
            {
              row: 0,
              col: 0,
              rowSpan: 1,
              colSpan: 1,
              header: false,
              text: 'First',
              bbox: [48, 60, 108, 84],
            },
            {
              row: 0,
              col: 1,
              rowSpan: 3,
              colSpan: 1,
              header: false,
              text: 'Tall',
              bbox: [108, 60, 168, 132],
            },
            {
              row: 0,
              col: 2,
              rowSpan: 1,
              colSpan: 1,
              header: false,
              text: 'Right',
              bbox: [168, 60, 228, 84],
            },
            {
              row: 1,
              col: 0,
              rowSpan: 1,
              colSpan: 1,
              header: false,
              text: 'Left 2',
              bbox: [48, 84, 108, 108],
            },
            {
              row: 1,
              col: 2,
              rowSpan: 1,
              colSpan: 1,
              header: false,
              text: 'Right 2',
              bbox: [168, 84, 228, 108],
            },
            {
              row: 2,
              col: 0,
              rowSpan: 1,
              colSpan: 1,
              header: false,
              text: 'Left 3',
              bbox: [48, 108, 108, 132],
            },
            {
              row: 2,
              col: 2,
              rowSpan: 1,
              colSpan: 1,
              header: false,
              text: 'Right 3',
              bbox: [168, 108, 228, 132],
            },
          ],
        });
        expect(gtSchema.parse(result)).toEqual(result);
      });
    },
    30_000,
  );

  test('counts only printed rows and orders an early tfoot after multiple bodies', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<table data-gt="table" data-gt-id="visual-rows">
          <tfoot><tr><td>Foot</td></tr></tfoot>
          <tbody><tr><td>Body 1</td></tr><tr style="display:none"><td>SECRET</td></tr></tbody>
          <tbody><tr><td>Body 2</td></tr></tbody>
          <thead><tr><td>Head</td></tr></thead>
        </table>`,
        tableCss,
      );
      const result = await readGroundTruth(page, source);
      expect(result.pages).toHaveLength(1);
      expect(result.blocks).toHaveLength(1);
      const block = result.blocks[0];
      expect(block?.type).toBe('table');
      if (block?.type !== 'table') return;
      expect(block.table).toEqual({
        rows: 4,
        cols: 1,
        cells: [
          {
            row: 0,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            header: true,
            text: 'Head',
            bbox: [48, 60, 228, 84],
          },
          {
            row: 1,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            header: false,
            text: 'Body 1',
            bbox: [48, 84, 228, 108],
          },
          {
            row: 2,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            header: false,
            text: 'Body 2',
            bbox: [48, 108, 228, 132],
          },
          {
            row: 3,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            header: false,
            text: 'Foot',
            bbox: [48, 132, 228, 156],
          },
        ],
      });
      expect(gtSchema.parse(result)).toEqual(result);
    });
  }, 30_000);

  test('reports non-table markup, an empty table and an all-hidden-row table together with their block ids', async () => {
    await withPage(async page => {
      await paginate(
        page,
        `<div data-gt="table" data-gt-id="not-table">Pretend table</div>
         <table data-gt="table" data-gt-id="empty-table"></table>
         <table data-gt="table" data-gt-id="hidden-rows"><tbody><tr style="display:none"><td>SECRET</td></tr></tbody></table>`,
        `${tableCss} table { height: 24pt; }`,
      );
      await expectMarkupIssues(page, [
        {
          id: 'not-table',
          problem:
            /(?:must|only|requires?|expected|not|needs).*(?:<table>|table element)|(?:<table>|table element).*(?:required|only)/i,
        },
        {
          id: 'empty-table',
          problem:
            /(?:no|zero|0).*(?:printed|visible|rows)|(?:rows).*(?:empty|missing|required)/i,
        },
        {
          id: 'hidden-rows',
          problem:
            /(?:no|zero|0).*(?:printed|visible|rows)|(?:rows).*(?:empty|missing|required)/i,
        },
      ]);
    });
  }, 30_000);

  test.each(['data-gt-id', 'data-gt-checked', 'data-gt-cheked'])(
    'rejects cell attribute %s rather than silently discarding cell metadata',
    async attribute => {
      await withPage(async page => {
        await paginate(
          page,
          `<table data-gt="table" data-gt-id="cell-metadata"><tbody><tr><td ${attribute}="true">Printed</td></tr></tbody></table>`,
          tableCss,
        );
        await expectMarkupIssues(page, [
          {
            id: 'cell-metadata',
            problem: new RegExp(
              `${attribute}.*(?:not allowed|forbidden|unsupported|must not|unexpected|invalid)|(?:not allowed|forbidden|unsupported|must not|unexpected|invalid).*${attribute}`,
              'i',
            ),
          },
        ]);
      });
    },
    30_000,
  );
});

// T03 §5: exercise the actual Paged.js failure, not a mocked measurement or
// manually moved cell. The 12pt remainder at H=420 loses the next 24pt row.
describe('T13 lost rows in cross-page tables', () => {
  test('rejects a real Paged.js lost row with its cell text alongside other block errors', async () => {
    await withPage(async page => {
      const html = await readFile(
        new URL('../fixtures/table-cross-page.html', import.meta.url),
        'utf8',
      );
      const table = html.match(/<table[\s\S]*?<\/table>/)?.[0];
      if (!table) throw new Error('Missing cross-page fixture table');
      await paginate(
        page,
        `${table.replace('data-gt-id="t"', 'data-gt-id="lost-a"')}
         <div data-gt="table" data-gt-id="not-a-table">Invalid table markup</div>`,
        `@page { size: 600pt 420pt; margin: 48pt; }
         table { table-layout: fixed; border-collapse: separate; border-spacing: 0; width: 300pt; }
         td, th { padding: 0; border: 0; height: 24pt; }
         col.a { width: 120pt; } col.b { width: 180pt; }`,
      );
      // Guard the reproducer independently of the reader. A browser upgrade
      // that changes this split must not turn rejection into a false positive.
      const lostRows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.pagedjs_page table'))
          .filter(table =>
            Array.from(table.querySelectorAll('td')).some(
              cell => cell.textContent === 'r12',
            ),
          )
          .map(table => {
            const page = table.closest('.pagedjs_page');
            const cell = Array.from(table.querySelectorAll('td')).find(
              cell => cell.textContent === 'r12',
            );
            if (!page || !cell) throw new Error('Missing lost-row cell/page');
            const box = cell.getBoundingClientRect();
            const pageBox = page.getBoundingClientRect();
            return {
              id: table.getAttribute('data-gt-id'),
              rects: cell.getClientRects().length,
              outside: box.right > pageBox.right,
              nextFirstCell:
                page.nextElementSibling?.querySelector('tbody td')?.textContent,
            };
          }),
      );
      expect(lostRows).toEqual([
        { id: 'lost-a', rects: 2, outside: true, nextFirstCell: 'r13' },
      ]);
      // Both independent failures must be listed; reporting only the table's
      // oversized bbox does not help the pack author find the missing row.
      await expectMarkupIssues(page, [
        { id: 'lost-a', problem: /r12/ },
        { id: 'not-a-table', problem: /table/i },
      ]);
    });
  }, 30_000);
});
