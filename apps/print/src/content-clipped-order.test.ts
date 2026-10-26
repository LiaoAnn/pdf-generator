import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { type PrintedState, RenderError, renderPdf } from './lib.ts';

const clipped = [
  'page 1 div clipped 50.0px at the bottom',
  'page 1 span clipped 20.0px at the right',
];
const outside = ['page 1 div 10.0px below its content area'];
const moved = ['page 1 .pagedjs_page_content moved 5.0px'];

async function run(after: PrintedState) {
  let printed = false;
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, pageWidth?: number) => {
      if (pageWidth !== undefined) return printed ? after : {};
      return {
        pageCount: 1,
        pageSize: { width: 793.7, height: 1122.5 },
        unloadedFaces: [],
        fragmentedRows: [],
      };
    }),
    pdf: vi.fn(async () => {
      printed = true;
      return new Uint8Array(
        readFileSync(
          new URL('./test-fixtures/blank-1-pages.pdf', import.meta.url),
        ),
      );
    }),
    close: vi.fn(async () => {}),
  };
  const inspect = vi.fn(async () => 'ground truth');
  const outcome = await renderPdf(
    fakeBrowserContext(page).browser,
    {
      html: '<!doctype html><html><body><div data-gt="image"></div></body></html>',
      page: { size: 'A4', orientation: 'portrait' },
    },
    {
      assetOrigin: 'https://print-assets.example.test',
      store: { put: async () => {}, delete: async () => {} },
      inspect,
    },
  ).then(
    result => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { outcome, page, inspect };
}

test('clipping first found after printing rejects with RenderError and preserves every diagnostic', async () => {
  const { outcome, page, inspect } = await run({ clippedContent: clipped });
  expect(outcome).toHaveProperty('error');
  const { error } = outcome as { error: unknown };
  expect(error).toBeInstanceOf(RenderError);
  expect(error).toMatchObject({ code: 'content_clipped', details: clipped });
  expect(page.pdf).toHaveBeenCalledTimes(1);
  expect(inspect).not.toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledTimes(1);
});

test.each([
  { name: 'absent', state: {} },
  { name: 'empty', state: { clippedContent: [] } },
])(
  '$name clipping diagnostics allow ground-truth inspection',
  async ({ state }) => {
    const { outcome, inspect } = await run(state);
    expect(outcome).toHaveProperty('result');
    expect(inspect).toHaveBeenCalledTimes(1);
  },
);

test('print_overflow keeps precedence over simultaneous ancestor clipping', async () => {
  const { outcome } = await run({
    outsidePages: outside,
    clippedContent: clipped,
  });
  expect(outcome).toMatchObject({
    error: { code: 'print_overflow', details: outside },
  });
});

test.each([false, true])(
  'page_box_moved wins over clipping with outsidePages=%s',
  async withOverflow => {
    const { outcome } = await run({
      movedBoxes: moved,
      clippedContent: clipped,
      ...(withOverflow ? { outsidePages: outside } : {}),
    });
    expect(outcome).toMatchObject({
      error: { code: 'page_box_moved', details: moved },
    });
  },
);

test('content_clipped precedes text_missing when clipping also removes PDF text', async () => {
  const { outcome } = await run({
    clippedContent: clipped,
    expectedText: [
      [
        {
          texts: [
            {
              text: 'MISSING FROM BLANK PDF',
              boxes: [{ x0: 0, y0: 0, x1: 100, y1: 100 }],
            },
          ],
        },
      ],
    ],
  });
  expect(outcome).toMatchObject({
    error: { code: 'content_clipped', details: clipped },
  });
});
