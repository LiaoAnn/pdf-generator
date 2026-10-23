import type { Browser } from '@cloudflare/puppeteer';
import { afterEach, expect, test, vi } from 'vitest';
import { RenderError, renderPdf } from './lib.ts';

const request = {
  html: '<!doctype html><html><body>一月</body></html>',
  page: { size: 'A4', orientation: 'portrait' },
} as const;
const assetOrigin = 'https://print-assets.example.test';

function fakeBrowser() {
  const calls: string[] = [];
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const page = {
    goto: vi.fn(async (_url: string, _options?: unknown) => {
      calls.push('goto');
    }),
    setContent: vi.fn(async (_html: string, _options?: unknown) => {
      calls.push('setContent');
    }),
    evaluate: vi.fn(async (_fn: unknown) => {
      calls.push('ready');
      return { pageCount: 3, unloadedFaces: [], fragmentedRows: [] };
    }),
    pdf: vi.fn(async (_options: unknown) => {
      calls.push('pdf');
      return bytes;
    }),
    close: vi.fn(async () => {
      calls.push('close');
    }),
  };
  const browser = {
    newPage: vi.fn(async () => {
      calls.push('newPage');
      return page;
    }),
  };
  return {
    browser: browser as unknown as Browser,
    page,
    calls,
    bytes,
    newPage: browser.newPage,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('inspection sees the completed page on the printing tab before PDF and its result reaches the caller', async () => {
  const fake = fakeBrowser();
  const inspected = { pages: 3, blocks: ['one', 'two'] };
  const inspect = vi.fn(async (page: unknown) => {
    fake.calls.push('inspect');
    expect(page).toBe(fake.page);
    return inspected;
  });
  const result = await renderPdf(fake.browser, request, {
    assetOrigin,
    inspect,
  });
  expect(fake.newPage).toHaveBeenCalledTimes(1);
  expect(fake.page.goto.mock.calls[0]?.[0]).toBe(`${assetOrigin}/blank`);
  expect(fake.page.setContent).toHaveBeenCalledTimes(1);
  expect(fake.page.setContent.mock.calls[0]?.[0]).toContain('一月');
  expect(fake.calls).toEqual([
    'newPage',
    'goto',
    'setContent',
    'ready',
    'inspect',
    'pdf',
    'close',
  ]);
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

test('a caller without an inspect hook still receives the ready page count and PDF', async () => {
  const fake = fakeBrowser();
  await expect(
    renderPdf(fake.browser, request, { assetOrigin }),
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
  const rendering = renderPdf(fake.browser, request, { assetOrigin, inspect });
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.page.evaluate).toHaveBeenCalledTimes(1);
  expect(inspect).not.toHaveBeenCalled();
  expect(fake.page.pdf).not.toHaveBeenCalled();
  expect(fake.page.close).not.toHaveBeenCalled();
  finishPagination({ pageCount: 7, unloadedFaces: [], fragmentedRows: [] });
  await expect(rendering).resolves.toEqual({
    pdf: fake.bytes,
    pageCount: 7,
    inspected: 'boxes',
  });
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(fake.page.pdf).toHaveBeenCalledTimes(1);
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test('an inspect failure closes the tab and never prints an uninspected page', async () => {
  const fake = fakeBrowser();
  const failure = new Error('ground truth could not be read');
  await expect(
    renderPdf(fake.browser, request, {
      assetOrigin,
      inspect: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(fake.page.pdf).not.toHaveBeenCalled();
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test.each(['goto', 'setContent', 'evaluate', 'pdf'] as const)(
  'a %s failure closes the opened tab',
  async stage => {
    const fake = fakeBrowser();
    const failure = new Error(`${stage} failed`);
    fake.page[stage].mockRejectedValueOnce(failure);
    await expect(
      renderPdf(fake.browser, request, { assetOrigin }),
    ).rejects.toThrow();
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
