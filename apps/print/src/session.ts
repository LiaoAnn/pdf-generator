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
}

const defaultKeepAliveMs = 600_000;
// Waits before the 2nd and 3rd attempt: an immediate reconnect after another
// request disconnected failed 2 of 3 times on the real platform (T03 §6.4).
const reconnectDelaysMs = [1_000, 2_000];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    return { browser, sessionId: undefined, release: () => browser.close() };
  }
  const kept = (browser: Browser): OpenedBrowser => ({
    browser,
    sessionId: browser.sessionId(),
    release: async () => browser.disconnect(),
  });
  if (session !== 'new') {
    for (let attempt = 0; ; attempt++) {
      try {
        return kept(await puppeteer.connect(binding, session));
      } catch {
        const delay = reconnectDelaysMs[attempt];
        if (delay === undefined) break;
        await sleep(delay);
      }
    }
  }
  return kept(await puppeteer.launch(binding, { keep_alive: keepAliveMs }));
}
