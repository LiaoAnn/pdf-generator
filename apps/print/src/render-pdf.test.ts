import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

const request = {
  html: '<!doctype html><html><body>一月</body></html>',
  page: { size: 'A4', orientation: 'portrait' },
} as const;
const assetOrigin = 'https://print-assets.example.test';

const ready = {
  pageCount: 3,
  // A4 in CSS px, as the runtime reports its largest Paged.js page.
  pageSize: { width: 793.7, height: 1122.5 },
  unloadedFaces: [] as string[],
  fragmentedRows: [] as string[],
};

function fakeBrowser() {
  const calls: string[] = [];
  // Which side of the PDF each `printed` read happened on.
  const printedWidths: { width: number; afterPdf: boolean }[] = [];
  const bytes = new Uint8Array(
    readFileSync(new URL('./test-fixtures/blank-3-pages.pdf', import.meta.url)),
  );
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async (_url: string, _options?: unknown) => {
      calls.push('goto');
    }),
    setContent: vi.fn(async (_html: string, _options?: unknown) => {
      calls.push('setContent');
    }),
    // The runtime's `printed` is the call that gets the page width.
    evaluate: vi.fn(async (_fn: unknown, pageWidth?: number) => {
      if (pageWidth !== undefined) {
        calls.push('printed');
        printedWidths.push({
          width: pageWidth,
          afterPdf: calls.includes('pdf'),
        });
        return { fragmentedRows: [] };
      }
      calls.push('ready');
      return { ...ready, pageCount: 3 };
    }),
    pdf: vi.fn(async (_options: unknown) => {
      calls.push('pdf');
      return bytes;
    }),
    close: vi.fn(async () => {
      calls.push('close');
    }),
  };
  let medium: string | undefined;
  let viewport: { width: number; height: number } | undefined;
  page.emulateMediaType.mockImplementation(async type => {
    medium = type;
    calls.push(`medium:${type}`);
  });
  page.setViewport.mockImplementation(async value => {
    viewport = value;
    calls.push('viewport');
  });
  const fake = fakeBrowserContext(page);
  fake.context.newPage.mockImplementation(async () => {
    calls.push('newPage');
    return page as unknown as Awaited<ReturnType<typeof fake.context.newPage>>;
  });
  return {
    browser: fake.browser,
    page,
    calls,
    printedWidths,
    bytes,
    layout: () => ({ medium, viewport }),
    newPage: fake.context.newPage,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('inspection sees the completed page in print media at PDF width and its result reaches the caller', async () => {
  const fake = fakeBrowser();
  const put = vi.fn(async (_key: string, _value: string | Uint8Array) => {});
  const inspected = { pages: 3, blocks: ['one', 'two'] };
  const inspect = vi.fn(async (page: unknown) => {
    fake.calls.push('inspect');
    expect(page).toBe(fake.page);
    expect(fake.layout()).toMatchObject({
      medium: 'print',
      viewport: { width: 793 },
    });
    return inspected;
  });
  const result = await renderPdf(fake.browser, request, {
    store: { put, delete: async () => {} },
    assetOrigin,
    inspect,
  });
  expect(fake.newPage).toHaveBeenCalledTimes(1);
  expect(fake.page.goto).toHaveBeenCalledTimes(1);
  const documentUrl = new URL(
    fake.page.goto.mock.calls[0]?.[0] ?? 'about:blank',
  );
  expect(documentUrl.origin).toBe(assetOrigin);
  expect(documentUrl.pathname).toMatch(/^\/pack\/[^/]+\/.+$/);
  expect(put).toHaveBeenCalled();
  expect(
    put.mock.calls.some(([, value]) =>
      (typeof value === 'string'
        ? value
        : new TextDecoder().decode(value)
      ).includes('一月'),
    ),
  ).toBe(true);
  expect(fake.page.setContent).not.toHaveBeenCalled();
  // Pagination must finish before inspection. A PDF probe may establish
  // the print viewport before the hook reads GT.
  expect(fake.calls.indexOf('ready')).toBeLessThan(
    fake.calls.indexOf('inspect'),
  );
  expect(
    fake.calls.filter(
      call =>
        !['ready', 'pdf', 'printed', 'viewport', 'medium:print'].includes(call),
    ),
  ).toEqual(['newPage', 'goto', 'inspect', 'close']);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(fake.page.pdf).toHaveBeenCalledWith({
    preferCSSPageSize: true,
    printBackground: true,
  });
  expect(result).toEqual({
    pdf: fake.bytes,
    pageCount: inspected.pages,
    inspected,
  });
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

// Regression: emulating print media only after the PDF was printed lets a
// stylesheet that applies in print only load its images and fonts after the
// PDF was made, so the ground truth measured afterwards describes a layout
// the PDF doesn't have (T07-20 review round 3).
test('print media at the PDF width is in place before the PDF is printed, and the layout is read both before and after it', async () => {
  const fake = fakeBrowser();
  await renderPdf(fake.browser, request, {
    store: { put: async () => {}, delete: async () => {} },
    assetOrigin,
  });
  const at = (call: string) => fake.calls.indexOf(call);
  const pdf = at('pdf');
  expect(pdf).toBeGreaterThan(-1);
  expect(at('medium:print')).toBeGreaterThan(at('ready'));
  expect(at('medium:print')).toBeLessThan(pdf);
  expect(at('viewport')).toBeGreaterThan(at('ready'));
  expect(at('viewport')).toBeLessThan(pdf);
  expect(fake.page.setViewport).toHaveBeenCalledWith({
    width: 793,
    height: 1122,
  });
  // `printed` runs once before and once after the PDF; any extra reads
  // (waiting for resources) are fine.
  expect(fake.calls.indexOf('printed')).toBeLessThan(pdf);
  expect(fake.calls.lastIndexOf('printed')).toBeGreaterThan(pdf);
  // Before the PDF exists the width is the largest Paged.js page; afterwards
  // the PDF is the authority on what was printed, so it is the PDF's own page
  // width (the fixture's 595 pt pages, 793.33 CSS px), as in T07-18.
  const pdfPageWidth = (595 * 96) / 72;
  expect(fake.printedWidths.some(read => !read.afterPdf)).toBe(true);
  expect(fake.printedWidths.some(read => read.afterPdf)).toBe(true);
  for (const { width, afterPdf } of fake.printedWidths) {
    expect(width).toBeCloseTo(
      afterPdf ? pdfPageWidth : ready.pageSize.width,
      1,
    );
  }
});

test('a caller without an inspect hook still receives the ready page count and PDF', async () => {
  const fake = fakeBrowser();
  await expect(
    renderPdf(fake.browser, request, {
      assetOrigin,
      store: { put: async () => {}, delete: async () => {} },
    }),
  ).resolves.toEqual({ pdf: fake.bytes, pageCount: 3, inspected: undefined });
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test('a pending pagination promise prevents inspection and printing until it resolves', async () => {
  vi.useFakeTimers();
  const fake = fakeBrowser();
  let finishPagination: (
    ready: Awaited<ReturnType<typeof fake.page.evaluate>>,
  ) => void = () => {
    throw new Error('pagination evaluation has not started');
  };
  fake.page.evaluate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishPagination = resolve;
      }),
  );
  const inspect = vi.fn(async () => 'boxes');
  const rendering = renderPdf(fake.browser, request, {
    assetOrigin,
    inspect,
    store: { put: async () => {}, delete: async () => {} },
  });
  // Observe an early setup rejection even if a preceding assertion fails.
  void rendering.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.page.evaluate).toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(fake.page.pdf).not.toHaveBeenCalled();
  expect(fake.page.close).not.toHaveBeenCalled();
  const sevenPages = new Uint8Array(
    readFileSync(new URL('./test-fixtures/blank-7-pages.pdf', import.meta.url)),
  );
  fake.page.pdf.mockResolvedValueOnce(sevenPages);
  finishPagination({ ...ready, pageCount: 7 });
  await expect(rendering).resolves.toEqual({
    pdf: sevenPages,
    pageCount: 7,
    inspected: 'boxes',
  });
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(fake.page.pdf).toHaveBeenCalledTimes(1);
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test('an inspect failure closes the tab and rejects the render', async () => {
  const fake = fakeBrowser();
  const failure = new Error('ground truth could not be read');
  await expect(
    renderPdf(fake.browser, request, {
      store: { put: async () => {}, delete: async () => {} },
      assetOrigin,
      inspect: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test.each(['goto', 'evaluate', 'pdf'] as const)(
  'a %s failure closes the opened tab',
  async stage => {
    const fake = fakeBrowser();
    const failure = new Error(`${stage} failed`);
    fake.page[stage].mockRejectedValueOnce(failure);
    await expect(
      renderPdf(fake.browser, request, {
        assetOrigin,
        store: { put: async () => {}, delete: async () => {} },
      }),
    ).rejects.toBe(failure);
    expect(fake.page.close).toHaveBeenCalledTimes(1);
    if (stage !== 'pdf') expect(fake.page.pdf).not.toHaveBeenCalled();
  },
);

test.each([
  ['explicit timeout', 25],
  ['default timeout', undefined],
] as const)(
  'unfinished pagination hits the %s without inspecting or printing',
  async (_name, timeoutMs) => {
    vi.useFakeTimers();
    const fake = fakeBrowser();
    fake.page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
    const inspect = vi.fn();
    const rendering = renderPdf(fake.browser, request, {
      store: { put: async () => {}, delete: async () => {} },
      assetOrigin,
      inspect,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    // Attach the rejection handler before advancing time, avoiding an unhandled
    // rejection while proving the promise is still pending before the deadline.
    const outcome = rendering.then(
      () => ({ resolved: true }),
      (error: unknown) => error,
    );
    const settled = vi.fn();
    void outcome.then(settled);
    const deadline = timeoutMs ?? 60_000;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({
      code: 'pagination_timeout',
      details: expect.any(Array),
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(fake.page.pdf).not.toHaveBeenCalled();
    expect(fake.page.close).toHaveBeenCalledTimes(1);
  },
);
