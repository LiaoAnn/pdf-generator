// T03 spike: print a Paged.js document with Browser Rendering and read data-gt boxes.
import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';

interface Env {
  ASSETS: Fetcher;
  BROWSER: Fetcher;
}

// The browser never fetches the Worker over the network: every request to this
// origin is answered from the Worker's static assets through request interception.
const ORIGIN = 'https://print.invalid';

async function openDoc(env: Env, browser: Browser, opts: { media?: 'print' | 'screen'; path?: string; css?: string }) {
  const page = await browser.newPage();
  const fetched: { url: string; bytes: number; ms: number }[] = [];
  await page.setRequestInterception(true);
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
  await page.goto(`${ORIGIN}${opts.path ?? '/doc.html'}`, { waitUntil: 'load' });
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
    if (url.pathname === '/run' || url.pathname === '/pdf') {
      const media = (url.searchParams.get('media') as 'print' | 'screen' | null) ?? undefined;
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const t0 = Date.now();
        const r = await openDoc(env, browser, {
          media,
          path: url.searchParams.get('doc') ?? undefined,
          css: url.searchParams.get('css') ?? undefined,
        });
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
        await browser.close();
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
