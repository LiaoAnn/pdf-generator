import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { type PrintReadyState, RenderError, renderPdf } from './lib.ts';

const origin = 'https://print-assets.example.test';
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString(
  'base64',
);
const request = {
  html: '<!doctype html><html><body><p data-gt="text">PACK</p></body></html>',
  page: { size: 'A4', orientation: 'portrait' },
  pack: {
    template: 'templates/report.hbs',
    files: { 'assets/logo.svg': svg, 'assets/報表 logo.svg': svg },
  },
} as const;
const ready = {
  pageCount: 1,
  unloadedFaces: [] as string[],
  fragmentedRows: [] as string[],
};

type Stage = 'goto' | 'ready' | 'inspect' | 'pdf';

// Requests use the real CDP event shape and are dispatched synchronously.
function fakeTab(
  options: {
    state?: Partial<PrintReadyState>;
    hangs?: boolean;
    fire?: Partial<Record<Stage, string[]>>;
  } = {},
) {
  const fetch = fakeFetch();
  const requests: Record<string, string> = {};
  let documentUrl = '';
  const fire = (stage: Stage) => {
    for (const template of options.fire?.[stage] ?? []) {
      const url = template.replace(
        '{id}',
        documentUrl.split('/')[4] ?? 'unknown',
      );
      const hash = url.indexOf('#');
      requests[template] =
        hash < 0
          ? fetch.pause(url)
          : fetch.pause(url.slice(0, hash), url.slice(hash));
    }
  };
  const page = {
    createCDPSession: fetch.createCDPSession,
    setCacheEnabled: fetch.setCacheEnabled,
    emulateMediaType: fetch.emulateMediaType,
    setViewport: fetch.setViewport,
    goto: vi.fn(async (url: string) => {
      documentUrl = url;
      fire('goto');
    }),
    evaluate: vi.fn(async () => {
      fire('ready');
      if (options.hangs) return new Promise<never>(() => {});
      return { ...ready, ...options.state };
    }),
    pdf: vi.fn(async () => {
      fire('pdf');
      return new Uint8Array(
        readFileSync(
          new URL('./test-fixtures/blank-1-pages.pdf', import.meta.url),
        ),
      );
    }),
    close: vi.fn(async () => {}),
  };
  const context = fakeBrowserContext(page);
  return {
    ...context,
    newPage: context.context.newPage,
    page,
    fetch,
    requests,
    inspect: async () => {
      fire('inspect');
      return 'ground truth';
    },
  };
}

// Pin exactly one resolution per request, while allowing unrelated CDP params.
function expectResolution(
  tab: ReturnType<typeof fakeTab>,
  url: string,
  allowed: boolean,
) {
  const id = tab.requests[url];
  expect(id, url).toBeDefined();
  const resolutions = tab.fetch.send.mock.calls.filter(
    ([method, params]) =>
      (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') &&
      params?.requestId === id,
  );
  expect(resolutions, url).toHaveLength(1);
  expect(resolutions[0]?.[0], url).toBe(
    allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
  );
  if (!allowed)
    expect(resolutions[0]?.[1]).toMatchObject({
      errorReason: 'BlockedByClient',
    });
}

const run = (tab: ReturnType<typeof fakeTab>, timeoutMs?: number) =>
  renderPdf(tab.browser, request, {
    assetOrigin: origin,
    store: { put: async () => {}, delete: async () => {} },
    inspect: tab.inspect,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).then(
    result => ({ result }),
    (error: unknown) => ({ error }),
  );

const blocked = [
  ['another host', 'http://127.0.0.1:9/x.png'],
  ['https host', 'https://example.com/a.css'],
  ['a pack path that was not sent', `${origin}/pack/{id}/assets/other.png`],
  [
    'another print id with a path this print has',
    `${origin}/pack/00000000-0000-4000-8000-000000000000/assets/logo.svg`,
  ],
  ['the Worker route /print', `${origin}/print`],
  [
    'the print runtime path on another host',
    'https://evil.test/print-runtime.js',
  ],
  [
    "this print's pack path on another host",
    'https://evil.test/pack/{id}/assets/logo.svg',
  ],
  ['a lookalike of /fonts/', `${origin}/fonts-evil/NotoSansTC-Regular.otf`],
  ['a favicon on another host', 'https://evil.test/favicon.ico'],
] as const;

// Regression: an allow-list that matches paths alone, prefixes, or only some
// of the print's own URLs would either let a fixture load from outside its
// pack or abort the pack's own files (and with them the whole print).
test('continues only the print’s own URLs and fails every other request', async () => {
  const allowed = [
    `${origin}/pack/{id}/templates/report.hbs`,
    `${origin}/pack/{id}/assets/logo.svg`,
    // The browser percent-encodes the pack path it was given.
    `${origin}/pack/{id}/assets/${encodeURIComponent('報表 logo.svg')}`,
    `${origin}/print-runtime.js`,
    `${origin}/paged.polyfill.js`,
    `${origin}/fonts/NotoSansTC-Regular.otf`,
    'data:text/css,p%7Bcolor:red%7D',
    `${origin}/pack/{id}/assets/logo.svg#logo`,
  ];
  const tab = fakeTab({
    fire: { goto: [...allowed, ...blocked.map(b => b[1])] },
  });
  const outcome = await run(tab);
  expect(outcome).toHaveProperty('error');
  for (const url of allowed) expectResolution(tab, url, true);
  for (const [, url] of blocked) expectResolution(tab, url, false);
});

// Regression: enabling Fetch or registering its listener after navigation leaks
// the parser's first requests; cache hits must not bypass interception either.
test('enables Fetch, registers its handler and disables cache before document navigation', async () => {
  const tab = fakeTab();
  const outcome = await run(tab);
  expect(outcome).toHaveProperty('result');
  expect(tab.fetch.on).toHaveBeenCalledWith(
    'Fetch.requestPaused',
    expect.any(Function),
  );
  const enable = tab.fetch.send.mock.calls.findIndex(
    ([method]) => method === 'Fetch.enable',
  );
  expect(enable).toBeGreaterThanOrEqual(0);
  expect(tab.fetch.send.mock.calls[enable]?.[1]).toMatchObject({
    patterns: [{ urlPattern: '*' }],
  });
  const goto = tab.page.goto.mock.invocationCallOrder[0] ?? 0;
  expect(goto).toBeGreaterThan(0);
  expect(tab.fetch.on.mock.invocationCallOrder[0]).toBeLessThan(goto);
  expect(tab.fetch.send.mock.invocationCallOrder[enable]).toBeLessThan(goto);
  expect(tab.page.setCacheEnabled).toHaveBeenCalledWith(false);
  expect(tab.page.setCacheEnabled.mock.invocationCallOrder[0]).toBeLessThan(
    goto,
  );
});

// Regression: Chrome's own favicon request must not make every print fail.
test('aborts the browser’s own /favicon.ico request without failing the render', async () => {
  const favicon = `${origin}/favicon.ico`;
  const tab = fakeTab({ fire: { goto: [favicon] } });
  const outcome = await run(tab);
  expect(outcome).toHaveProperty('result');
  expectResolution(tab, favicon, false);
});

// Regression: only checking blocked requests at one point (after goto) lets a
// request made late (a stylesheet's font, an animation) pass into a PDF/gt.
test.each(['goto', 'ready', 'inspect', 'pdf'] as const)(
  'a request blocked while the %s step runs fails the render with request_blocked and no PDF',
  async stage => {
    const url = 'http://127.0.0.1:9/late.png';
    const tab = fakeTab({ fire: { [stage]: [url] } });
    const outcome = await run(tab);
    expect(outcome).toHaveProperty('error');
    const { error } = outcome as { error: unknown };
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({ code: 'request_blocked' });
    expect((error as RenderError).details.join('\n')).toContain(url);
    expect(outcome).not.toHaveProperty('result');
    expectResolution(tab, url, false);
    expect(tab.page.close).toHaveBeenCalledTimes(1);
  },
);

// Regression: a request the print blocked usually breaks something else
// (the font it asked for fails to load); the caller needs the cause, not the
// symptom, and must hear about the blocked URLs.
test.each([
  ['font_not_loaded', { unloadedFaces: ['Report Sans 400: error'] }, false],
  ['row_fragmented', { fragmentedRows: ['page 1: row'] }, false],
  ['pagination_timeout', {}, true],
] satisfies [string, Partial<PrintReadyState>, boolean][])(
  'request_blocked wins over %s and lists the blocked URLs',
  async (_symptom, state, hangs) => {
    const first = 'http://127.0.0.1:9/font.woff2';
    const second = `${origin}/pack/{id}/assets/other.png`;
    const tab = fakeTab({
      state,
      hangs,
      fire: { goto: [first, second] },
    });
    const outcome = await run(tab, 50);
    const { error } = outcome as { error: unknown };
    expect(error).toMatchObject({ code: 'request_blocked' });
    const details = (error as RenderError).details;
    expect(details.join('\n')).toContain(first);
    expect(details.join('\n')).toContain('/assets/other.png');
  },
);

function deferred() {
  let resolve: (value?: unknown) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

// Regression: closing a tab before a continue/fail acknowledgement detaches
// Fetch and Chrome resumes the still-paused request, even after a 422.
test.each([
  ['continue', `${origin}/print-runtime.js`, 'Fetch.continueRequest'],
  ['fail', 'https://outside.test/held.css', 'Fetch.failRequest'],
] as const)(
  'does not close while a %s acknowledgement is pending',
  async (_name, url, method) => {
    const tab = fakeTab({ fire: { ready: [url] } });
    const held = deferred();
    tab.fetch.send.mockImplementation(async command =>
      command === method ? held.promise : {},
    );
    const rendering = run(tab);
    try {
      await vi.waitFor(() => {
        expectResolution(tab, url, method === 'Fetch.continueRequest');
        expect(tab.page.evaluate).toHaveBeenCalled();
      });
      expect(tab.page.close).not.toHaveBeenCalled();
      expect(tab.context.close).not.toHaveBeenCalled();
    } finally {
      held.resolve();
    }
    const outcome = await rendering;
    expect(outcome).toHaveProperty(
      method === 'Fetch.continueRequest' ? 'result' : 'error',
    );
    expect(tab.page.close).toHaveBeenCalledTimes(1);
  },
);

// Regression: Paged.js can start a second @import XHR after rendering ends.
// A snapshot of pending sends misses another event delivered while draining.
test('fails late requests paused while draining before closing', async () => {
  const late = 'https://outside.test/polisher-import.css';
  const tab = fakeTab({ fire: { ready: [late] } });
  const first = deferred();
  const second = deferred();
  let count = 0;
  tab.fetch.send.mockImplementation(async method => {
    if (method !== 'Fetch.failRequest') return {};
    return ++count === 1 ? first.promise : second.promise;
  });
  const rendering = run(tab);
  try {
    await vi.waitFor(() => expectResolution(tab, late, false));
    expect(tab.page.close).not.toHaveBeenCalled();
    expect(tab.context.close).not.toHaveBeenCalled();
    const secondId = tab.fetch.pause('https://outside.test/another-import.css');
    await vi.waitFor(() =>
      expect(tab.fetch.send).toHaveBeenCalledWith(
        'Fetch.failRequest',
        expect.objectContaining({
          requestId: secondId,
          errorReason: 'BlockedByClient',
        }),
      ),
    );
    first.resolve();
    // Let the first acknowledgement finish. The newly paused
    // request must still prevent close, independently of the first one.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tab.page.close).not.toHaveBeenCalled();
    expect(tab.context.close).not.toHaveBeenCalled();
  } finally {
    first.resolve();
    second.resolve();
  }
  await rendering;
  expect(tab.page.close).toHaveBeenCalledTimes(1);
});

// Regression: invalid interception ids reject CDP sends. Treating rejection
// as an outstanding request forever would hang cleanup and mask the error.
test('a rejected fail acknowledgement is settled and preserves request_blocked', async () => {
  const url = 'https://outside.test/stale.css';
  const tab = fakeTab({ fire: { ready: [url] } });
  const held = deferred();
  tab.fetch.send.mockImplementation(async method =>
    method === 'Fetch.failRequest' ? held.promise : {},
  );
  const rendering = run(tab);
  try {
    await vi.waitFor(() => expectResolution(tab, url, false));
    expect(tab.page.close).not.toHaveBeenCalled();
    expect(tab.context.close).not.toHaveBeenCalled();
  } finally {
    held.reject(new Error('Invalid InterceptionId'));
  }
  const outcome = await rendering;
  expect(outcome).toHaveProperty('error');
  expect((outcome as { error: unknown }).error).toMatchObject({
    code: 'request_blocked',
    details: [url],
  });
  expect(tab.page.close).toHaveBeenCalledTimes(1);
});

// Regression: Fetch cannot intercept preconnect, and detaching resumes paused
// requests. The network guard must exist before a context-owned tab is opened.
// A bare hostname rule lets another port of the Worker's hostname out.
// Pin literal scheme/host/effective-port rules, including default ports that
// URL.host omits, so only the Worker's origin can bypass the refusing proxy.
test.each([
  ['https://print.example', 'https://print.example:443'],
  ['https://print.example:443', 'https://print.example:443'],
  ['https://print.example:8443', 'https://print.example:8443'],
  ['http://print.example', 'http://print.example:80'],
  ['http://127.0.0.1:8788', 'http://127.0.0.1:8788'],
])(
  'creates a proxy context bypassing only the Worker origin for %s (a bare hostname rule lets another port of the Worker’s hostname out)',
  async (assetOrigin, bypassRule) => {
    const tab = fakeTab();
    const outcome = await renderPdf(tab.browser, request, {
      assetOrigin,
      store: { put: async () => {}, delete: async () => {} },
    }).then(
      result => ({ result }),
      (error: unknown) => ({ error }),
    );
    expect(tab.createBrowserContext).toHaveBeenCalledTimes(1);
    const config = tab.createBrowserContext.mock.calls[0]?.[0];
    expect(config?.proxyServer).toEqual(expect.any(String));
    expect(config?.proxyServer?.length).toBeGreaterThan(0);
    expect(config?.proxyBypassList).toEqual(['<-loopback>', bypassRule]);
    expect(outcome).toHaveProperty('result');
    expect(tab.newPage).toHaveBeenCalledTimes(1);
    expect(tab.createBrowserContext.mock.invocationCallOrder[0]).toBeLessThan(
      tab.newPage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(tab.target).not.toHaveBeenCalled();
    expect(tab.defaultNewPage).not.toHaveBeenCalled();
  },
);

test('a createBrowserContext rejection propagates without opening any page', async () => {
  const tab = fakeTab();
  const failure = new Error('proxy context unavailable');
  tab.createBrowserContext.mockRejectedValueOnce(failure);
  const outcome = await run(tab);
  expect((outcome as { error: unknown }).error).toBe(failure);
  expect(tab.newPage).not.toHaveBeenCalled();
  expect(tab.defaultNewPage).not.toHaveBeenCalled();
  expect(tab.target).not.toHaveBeenCalled();
  expect(tab.context.close).not.toHaveBeenCalled();
});

// Regression: contexts accumulate on kept-alive browsers unless every exit
// closes them, after the tab and its published files have finished cleanup.
test.each([
  'success',
  'request_blocked',
  'pagination_timeout',
  'font_not_loaded',
  'row_fragmented',
  'page_count_mismatch',
  'text_missing',
  'goto',
  'evaluate',
  'pdf',
  'inspect',
  'newPage',
] as const)(
  'closes the proxy context after page and file cleanup on %s',
  async exit => {
    const tab = fakeTab({
      hangs: exit === 'pagination_timeout',
      fire:
        exit === 'request_blocked' ? { ready: ['https://outside.test/a'] } : {},
      state: {
        ...(exit === 'font_not_loaded'
          ? { unloadedFaces: ['Missing font'] }
          : {}),
        ...(exit === 'row_fragmented' ? { fragmentedRows: ['row 1'] } : {}),
        ...(exit === 'page_count_mismatch' ? { pageCount: 2 } : {}),
        ...(exit === 'text_missing'
          ? {
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
            }
          : {}),
      },
    });
    const failure = new Error(`${exit} failed`);
    if (exit === 'newPage') tab.newPage.mockRejectedValueOnce(failure);
    if (exit === 'goto' || exit === 'evaluate' || exit === 'pdf')
      tab.page[exit].mockRejectedValueOnce(failure);
    if (exit === 'inspect')
      tab.inspect = async () => {
        throw failure;
      };
    const stored = new Set<string>();
    const cleanup: string[] = [];
    tab.page.close.mockImplementation(async () => {
      await Promise.resolve();
      cleanup.push('page closed');
    });
    tab.context.close.mockImplementation(async () => {
      expect(stored.size).toBe(0);
      cleanup.push('context closed');
    });
    const outcome = await renderPdf(tab.browser, request, {
      assetOrigin: origin,
      timeoutMs: 10,
      inspect: tab.inspect,
      store: {
        put: async (key: string) => {
          stored.add(key);
        },
        delete: async (keys: string[]) => {
          await Promise.resolve();
          for (const key of keys) stored.delete(key);
          cleanup.push('files removed');
        },
      },
    }).then(
      result => ({ result }),
      (error: unknown) => ({ error }),
    );
    if (exit === 'success') expect(outcome).toHaveProperty('result');
    else if (['newPage', 'goto', 'evaluate', 'pdf', 'inspect'].includes(exit))
      expect((outcome as { error: unknown }).error).toBe(failure);
    else
      expect((outcome as { error: unknown }).error).toMatchObject({
        code: exit,
      });
    expect(tab.context.close).toHaveBeenCalledTimes(1);
    expect(tab.target).not.toHaveBeenCalled();
    expect(tab.defaultNewPage).not.toHaveBeenCalled();
    if (exit === 'newPage') {
      expect(tab.page.close).not.toHaveBeenCalled();
      expect(cleanup).toEqual(['context closed']);
    } else {
      expect(tab.page.close).toHaveBeenCalledTimes(1);
      expect(cleanup).toEqual([
        'page closed',
        'files removed',
        'context closed',
      ]);
    }
  },
);

// Regression: starting cleanup in order is insufficient if close/removal are
// not awaited; a context may still hold requests while its tab is closing.
test.each(['page close', 'file removal'] as const)(
  'keeps the proxy context alive until %s finishes',
  async stage => {
    const tab = fakeTab();
    const held = deferred();
    const remove = vi.fn(async (_keys: string[]) => {
      if (stage === 'file removal') await held.promise;
    });
    if (stage === 'page close')
      tab.page.close.mockImplementation(async () => {
        await held.promise;
      });
    const rendering = renderPdf(tab.browser, request, {
      assetOrigin: origin,
      store: { put: async () => {}, delete: remove },
    }).then(
      result => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(() =>
        expect(
          stage === 'page close' ? tab.page.close : remove,
        ).toHaveBeenCalled(),
      );
      expect(tab.context.close).not.toHaveBeenCalled();
      if (stage === 'page close') expect(remove).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await rendering;
    }
    expect(tab.context.close).toHaveBeenCalledTimes(1);
  },
);
