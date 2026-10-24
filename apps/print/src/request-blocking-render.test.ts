import type { Browser } from '@cloudflare/puppeteer';
import { expect, test, vi } from 'vitest';
import { RenderError, renderPdf } from './lib.ts';

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

// A tab whose requests the test fires through the handler renderPdf registers,
// the way puppeteer does: each request must end in continue() or abort().
function fakeTab(
  options: {
    state?: Partial<Readonly<Record<keyof typeof ready, unknown>>>;
    hangs?: boolean;
    fire?: Partial<Record<Stage, string[]>>;
  } = {},
) {
  const handlers: ((request: unknown) => unknown)[] = [];
  const requests: Record<
    string,
    { continue: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }
  > = {};
  let documentUrl = '';
  // Requests are fired for the URL as `/pack/<id>/…`; `{id}` is this print's.
  const resolve = (url: string) =>
    url.replace('{id}', documentUrl.split('/')[4] ?? 'unknown');
  const fire = async (stage: Stage) => {
    for (const template of options.fire?.[stage] ?? []) {
      const url = resolve(template);
      const entry = {
        continue: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };
      requests[template] = entry;
      for (const handler of handlers) {
        await handler({
          url: () => url,
          continue: entry.continue,
          abort: entry.abort,
          isInterceptResolutionHandled: () => false,
        });
      }
    }
  };
  const page = {
    setRequestInterception: vi.fn(async (_enabled: boolean) => {}),
    on: vi.fn((event: string, handler: (request: unknown) => unknown) => {
      if (event === 'request') handlers.push(handler);
    }),
    goto: vi.fn(async (url: string) => {
      documentUrl = url;
      await fire('goto');
    }),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      await fire('ready');
      if (options.hangs) return new Promise<never>(() => {});
      return { ...ready, ...options.state };
    }),
    pdf: vi.fn(async () => {
      await fire('pdf');
      return new Uint8Array([37, 80, 68, 70]);
    }),
    close: vi.fn(async () => {}),
  };
  return {
    page,
    requests,
    browser: { newPage: async () => page } as unknown as Browser,
    inspect: async () => {
      await fire('inspect');
      return 'ground truth';
    },
  };
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
test('continues only the print’s own URLs and aborts every other request', async () => {
  const allowed = [
    `${origin}/pack/{id}/templates/report.hbs`,
    `${origin}/pack/{id}/assets/logo.svg`,
    // The browser percent-encodes the pack path it was given.
    `${origin}/pack/{id}/assets/${encodeURIComponent('報表 logo.svg')}`,
    `${origin}/print-runtime.js`,
    `${origin}/paged.polyfill.js`,
    `${origin}/fonts/NotoSansTC-Regular.otf`,
  ];
  const tab = fakeTab({
    fire: { goto: [...allowed, ...blocked.map(b => b[1])] },
  });
  const outcome = await run(tab);
  expect(outcome).toHaveProperty('error');
  for (const url of allowed) {
    expect.soft(tab.requests[url]?.continue, url).toHaveBeenCalledTimes(1);
    expect.soft(tab.requests[url]?.abort, url).not.toHaveBeenCalled();
  }
  for (const [name, url] of blocked) {
    expect.soft(tab.requests[url]?.abort, name).toHaveBeenCalledTimes(1);
    expect.soft(tab.requests[url]?.continue, name).not.toHaveBeenCalled();
  }
});

// Regression: interception switched on after goto (or not at all) lets the
// document's first requests through.
test('turns request interception on and registers the handler before navigating', async () => {
  const tab = fakeTab();
  await run(tab);
  expect(tab.page.on).toHaveBeenCalledWith('request', expect.any(Function));
  expect(tab.page.setRequestInterception).toHaveBeenCalledWith(true);
  const goto = tab.page.goto.mock.invocationCallOrder[0] ?? 0;
  expect(goto).toBeGreaterThan(0);
  expect(tab.page.on.mock.invocationCallOrder[0]).toBeLessThan(goto);
  expect(
    tab.page.setRequestInterception.mock.invocationCallOrder[0],
  ).toBeLessThan(goto);
});

// Regression: Chrome's own favicon request must not make every print fail.
test('aborts the browser’s own /favicon.ico request without failing the render', async () => {
  const favicon = `${origin}/favicon.ico`;
  const tab = fakeTab({ fire: { goto: [favicon] } });
  const outcome = await run(tab);
  expect(outcome).toHaveProperty('result');
  expect(tab.requests[favicon]?.abort).toHaveBeenCalledTimes(1);
  expect(tab.requests[favicon]?.continue).not.toHaveBeenCalled();
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
] as const)(
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
