// T03 spike: print a Paged.js document with Browser Rendering and read data-gt boxes.
import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';

interface Env {
  ASSETS: Fetcher;
  BROWSER: Fetcher;
  // Shared secret for the deployed spike, so nobody else can spend browser time.
  TOKEN?: string;
}

// The browser never fetches the Worker over the network: every request to this
// origin is answered from the Worker's static assets through request interception.
const ORIGIN = 'https://print.invalid';

type OpenOpts = { media?: 'print' | 'screen'; path?: string; css?: string; origin?: string };

async function openDoc(env: Env, browser: Browser, opts: OpenOpts) {
  const page = await browser.newPage();
  const fetched: { url: string; bytes: number; ms: number }[] = [];
  // origin set: the browser fetches the document over the network (HTTP cache applies).
  // Otherwise every request is answered from static assets by interception.
  if (!opts.origin) await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return req.abort('blockedbyclient');
    const t = Date.now();
    const res = await env.ASSETS.fetch(new Request(`http://assets${url.pathname}`));
    let body = new Uint8Array(await res.arrayBuffer());
    // Experiment knob: extra CSS injected into the document (?css=...).
    if (opts.css && res.headers.get('content-type')?.startsWith('text/html')) {
      const html = new TextDecoder().decode(body).replace('</head>', `<style>${opts.css}</style></head>`);
      body = new TextEncoder().encode(html);
    }
    fetched.push({ url: url.pathname, bytes: body.byteLength, ms: Date.now() - t });
    await req.respond({
      status: res.status,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      body: body as unknown as Buffer,
    });
  });
  const consoleLog: string[] = [];
  page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
  if (opts.media) await page.emulateMediaType(opts.media);
  const t0 = Date.now();
  await page.goto(`${opts.origin ?? ORIGIN}${opts.path ?? '/doc.html'}`, { waitUntil: 'load' });
  const atLoad = await page.evaluate(() => ({
    done: (window as any).__t03.done,
    boxes: (window as any).__t03readBoxes(),
  }));
  const loadMs = Date.now() - t0;
  await page.waitForSelector('.pagedjs_page');
  const atFirstPage = await page.evaluate(() => ({
    done: (window as any).__t03.done,
    boxes: (window as any).__t03readBoxes(),
  }));
  await page.waitForFunction(() => (window as any).__t03.done === true, { timeout: 60_000 });
  const doneMs = Date.now() - t0;
  return { page, fetched, consoleLog, atLoad, atFirstPage, loadMs, doneMs };
}

// One full render: new tab, document, wait for Paged.js, PDF, close tab.
async function renderOnce(env: Env, browser: Browser, opts: OpenOpts) {
  const t0 = Date.now();
  const r = await openDoc(env, browser, opts);
  const pdf = await printPdf(r.page);
  const overflow = await r.page.evaluate(() => (window as any).__t03overflow().length);
  const pages = await r.page.evaluate(() => (window as any).__t03.total);
  await r.page.close();
  return { ms: Date.now() - t0, doneMs: r.doneMs, bytes: pdf.byteLength, pages, overflow };
}

// With ?session=<id>, reuse an existing browser session instead of launching a new one.
async function acquire(env: Env, session: string | null) {
  const browser = session ? await puppeteer.connect(env.BROWSER, session) : await puppeteer.launch(env.BROWSER);
  return { browser, release: () => (session ? browser.disconnect() : browser.close()) };
}

async function bench(env: Env, q: URLSearchParams, opts: OpenOpts) {
  const session = q.get('session');
  const browsers = Number(q.get('browsers') ?? 1);
  const tabs = Number(q.get('tabs') ?? 1);
  const n = Number(q.get('n') ?? 5); // renders per tab lane
  const t0 = Date.now();
  const lanes = await Promise.all(
    Array.from({ length: browsers }, async (_, b) => {
      const tl = Date.now();
      let browser: Browser;
      let release: () => unknown;
      try {
        ({ browser, release } = await acquire(env, browsers === 1 ? session : null));
      } catch (e) {
        return { browser: b, launchError: String(e), launchMs: Date.now() - tl };
      }
      const launchMs = Date.now() - tl;
      try {
        const results = await Promise.all(
          Array.from({ length: tabs }, async () => {
            const out = [];
            for (let i = 0; i < n; i++) {
              try {
                out.push(await renderOnce(env, browser, opts));
              } catch (e) {
                out.push({ error: String(e).slice(0, 300) });
              }
            }
            return out;
          }),
        );
        return { browser: b, launchMs, sessionId: browser.sessionId(), results: results.flat() };
      } finally {
        await release();
      }
    }),
  );
  const wallMs = Date.now() - t0;
  const ok = lanes.flatMap((l) => ('results' in l ? l.results.filter((r) => !('error' in r)) : []));
  return {
    params: { browsers, tabs, n, mode: opts.origin ? 'url' : 'intercept', path: opts.path },
    wallMs,
    pdfs: ok.length,
    pdfsPerMinute: +((ok.length / wallMs) * 60_000).toFixed(1),
    lanes,
  };
}

async function printPdf(page: Page) {
  return page.pdf({ preferCSSPageSize: true, printBackground: true });
}

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const q = url.searchParams;
    const isApi = ['/run', '/pdf', '/bench', '/limits', '/reuse', '/launch', '/close'].includes(url.pathname);
    if (isApi && env.TOKEN && q.get('token') !== env.TOKEN) return new Response('forbidden', { status: 403 });
    const origin = q.get('src') === 'url' ? (q.get('origin') ?? url.origin) : undefined;
    if (url.pathname === '/limits') {
      return Response.json({ limits: await puppeteer.limits(env.BROWSER), sessions: await puppeteer.sessions(env.BROWSER) });
    }
    if (url.pathname === '/bench') {
      return Response.json(await bench(env, q, { path: q.get('doc') ?? '/doc-fixed', origin }));
    }
    if (url.pathname === '/launch') {
      const t0 = Date.now();
      const b = await puppeteer.launch(env.BROWSER, { keep_alive: Number(q.get('keep_alive') ?? 600_000) });
      const out = { sessionId: b.sessionId(), launchMs: Date.now() - t0, version: await b.version() };
      b.disconnect();
      return Response.json(out);
    }
    if (url.pathname === '/close') {
      const b = await puppeteer.connect(env.BROWSER, q.get('session') ?? '');
      await b.close();
      return Response.json({ closed: true });
    }
    if (url.pathname === '/reuse') {
      // Session reuse and idle timeout: launch with keep_alive, disconnect, wait, reconnect.
      const keepAlive = q.has('keep_alive') ? Number(q.get('keep_alive')) : undefined;
      const waitMs = Number(q.get('wait') ?? 5_000);
      const t0 = Date.now();
      const b1 = await puppeteer.launch(env.BROWSER, keepAlive ? { keep_alive: keepAlive } : {});
      const launchMs = Date.now() - t0;
      const sessionId = b1.sessionId();
      const first = q.get('first') === '0' ? null : await renderOnce(env, b1, { path: '/doc-fixed' });
      b1.disconnect();
      await new Promise((r) => setTimeout(r, waitMs));
      const t1 = Date.now();
      let reconnect: unknown;
      try {
        const b2 = await puppeteer.connect(env.BROWSER, sessionId);
        const connectMs = Date.now() - t1;
        const second = await renderOnce(env, b2, { path: '/doc-fixed' });
        await b2.close();
        reconnect = { ok: true, connectMs, second };
      } catch (e) {
        reconnect = { ok: false, error: String(e).slice(0, 300), afterMs: Date.now() - t1 };
      }
      return Response.json({ keepAlive, waitMs, launchMs, sessionId, first, reconnect });
    }
    if (url.pathname === '/run' || url.pathname === '/pdf') {
      const media = (url.searchParams.get('media') as 'print' | 'screen' | null) ?? undefined;
      const { browser, release } = await acquire(env, q.get('session'));
      let openPage: Page | undefined;
      try {
        const t0 = Date.now();
        const r = await openDoc(env, browser, {
          media,
          path: url.searchParams.get('doc') ?? undefined,
          css: url.searchParams.get('css') ?? undefined,
          origin,
        });
        openPage = r.page;
        const inPage = await r.page.evaluate(() => ({
          t03: (window as any).__t03,
          snapshots: (window as any).__t03snapshots,
        }));
        const screenAfter = await r.page.evaluate(() => (window as any).__t03readBoxes());
        const rowsScreen = await r.page.evaluate(() => (window as any).__t03rows());
        await r.page.emulateMediaType('print');
        const printAfter = await r.page.evaluate(() => (window as any).__t03readBoxes());
        const rowsPrint = await r.page.evaluate(() => (window as any).__t03rows());
        const overflow = await r.page.evaluate(() => (window as any).__t03overflow());
        const tp = Date.now();
        const pdf = await printPdf(r.page);
        const pdfMs = Date.now() - tp;
        if (url.pathname === '/pdf') {
          return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
        }
        return Response.json({
          browserVersion: await browser.version(),
          timings: { loadMs: r.loadMs, doneMs: r.doneMs, pdfMs, totalMs: Date.now() - t0 },
          fetched: r.fetched,
          console: r.consoleLog,
          paged: inPage.t03,
          snapshots: {
            ...inPage.snapshots,
            puppeteerLoad: r.atLoad.boxes,
            puppeteerFirstPage: r.atFirstPage.boxes,
            afterDoneScreen: screenAfter,
            afterDonePrint: printAfter,
          },
          rows: { screen: rowsScreen, print: rowsPrint },
          overflow,
          doneAtLoad: r.atLoad.done,
          doneAtFirstPage: r.atFirstPage.done,
          pdfBase64: b64(pdf),
        });
      } finally {
        await openPage?.close().catch(() => {});
        await release();
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
