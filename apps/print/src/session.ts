import puppeteer, { type Browser } from '@cloudflare/puppeteer';

type Binding = Parameters<typeof puppeteer.launch>[0];

export interface OpenBrowserOptions {
  /**
   * Omitted: a browser for this request only. `'new'`: a kept-alive browser
   * session others can reconnect to. Any other value: the id of such a
   * session to reconnect to.
   */
  session?: string;
  /** Idle time before a kept-alive session ends (Browser Rendering max 20 min). */
  keepAliveMs?: number;
}

export interface OpenedBrowser {
  browser: Browser;
  /** The kept-alive session's id, or undefined for a one-request browser. */
  sessionId: string | undefined;
  /** Closes a one-request browser; disconnects from a kept-alive session. */
  release: () => Promise<void>;
  /** Closes the browser, kept-alive or not. */
  discard: () => Promise<void>;
}

const defaultKeepAliveMs = 600_000;
// Waits before the 2nd and 3rd attempt: an immediate reconnect after another
// request disconnected failed 2 of 3 times on the real platform (T03 §6.4).
const reconnectDelaysMs = [1_000, 2_000];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Reconnects to a kept-alive session, retrying while a preceding disconnect
 * settles; undefined when the session can't be reached.
 */
export async function connectSession(
  binding: Binding,
  session: string,
): Promise<Browser | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await puppeteer.connect(binding, session);
    } catch {
      const delay = reconnectDelaysMs[attempt];
      if (delay === undefined) return undefined;
      await sleep(delay);
    }
  }
}

/**
 * Launches a browser, or reconnects to a kept-alive session so a batch pays
 * the launch (tens of seconds remotely, T03 §6.2) once. A session that can't
 * be reached after the retries is replaced by a new one.
 */
export async function openBrowser(
  binding: Binding,
  options: OpenBrowserOptions = {},
): Promise<OpenedBrowser> {
  const { session, keepAliveMs = defaultKeepAliveMs } = options;
  if (session === undefined) {
    const browser = await puppeteer.launch(binding);
    const close = () => browser.close();
    return { browser, sessionId: undefined, release: close, discard: close };
  }
  const kept = (browser: Browser): OpenedBrowser => ({
    browser,
    sessionId: browser.sessionId(),
    release: async () => browser.disconnect(),
    discard: () => browser.close(),
  });
  if (session !== 'new') {
    const connected = await connectSession(binding, session);
    if (connected) return kept(connected);
  }
  return kept(await puppeteer.launch(binding, { keep_alive: keepAliveMs }));
}
