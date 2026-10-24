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

// The idle cap of a kept-alive session. Browser Rendering ends a session
// after its keep_alive without a connection; local Browser Rendering ignores
// keep_alive, so closeIdleSessions enforces the same cap.
const idleCapMs = 60_000;
const defaultKeepAliveMs = idleCapMs;
// Waits before the 2nd and 3rd attempt: an immediate reconnect after another
// request disconnected failed 2 of 3 times on the real platform (T03 §6.4).
const reconnectDelaysMs = [1_000, 2_000];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Local Browser Rendering sometimes fails one of several concurrent launches
// after starting its Chrome, which then can't be reached or closed (T16-3:
// 1 of 20 concurrent launches, 0 of 24 sequential). One launch at a time.
let launching: Promise<unknown> = Promise.resolve();

function launch(
  binding: Binding,
  options?: Parameters<typeof puppeteer.launch>[1],
): Promise<Browser> {
  const launched = launching.then(() =>
    options === undefined
      ? puppeteer.launch(binding)
      : puppeteer.launch(binding, options),
  );
  launching = launched.catch(() => undefined);
  return launched;
}

// This isolate's view of kept sessions: how many prints use each, and since
// when each has been idle (released, or first seen without a connection).
const inUse = new Map<string, number>();
const idleSince = new Map<string, number>();

function claim(id: string) {
  inUse.set(id, (inUse.get(id) ?? 0) + 1);
  idleSince.delete(id);
}

function unclaim(id: string) {
  const count = (inUse.get(id) ?? 1) - 1;
  if (count > 0) inUse.set(id, count);
  else inUse.delete(id);
}

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
    const browser = await launch(binding);
    const close = () => browser.close();
    return { browser, sessionId: undefined, release: close, discard: close };
  }
  const kept = (browser: Browser): OpenedBrowser => {
    const sessionId = browser.sessionId();
    claim(sessionId);
    return {
      browser,
      sessionId,
      release: async () => {
        unclaim(sessionId);
        if (!inUse.has(sessionId)) idleSince.set(sessionId, Date.now());
        browser.disconnect();
      },
      discard: async () => {
        unclaim(sessionId);
        await browser.close();
      },
    };
  };
  if (session !== 'new') {
    const connected = await connectSession(binding, session);
    if (connected) return kept(connected);
  }
  return kept(await launch(binding, { keep_alive: keepAliveMs }));
}

/**
 * Closes the kept-alive sessions that have had no connection for the idle
 * cap, so a session its caller never closed doesn't outlive it (T16-3).
 * Never throws: a failure only leaves sessions for a later sweep.
 */
export async function closeIdleSessions(binding: Binding): Promise<void> {
  let sessions: Awaited<ReturnType<typeof puppeteer.sessions>>;
  try {
    sessions = await puppeteer.sessions(binding);
  } catch (error) {
    console.warn('listing browser sessions failed', error);
    return;
  }
  const now = Date.now();
  const listed = new Set(sessions.map(session => session.sessionId));
  for (const id of idleSince.keys()) if (!listed.has(id)) idleSince.delete(id);
  const expired: string[] = [];
  for (const { sessionId, connectionId, connectionStartTime } of sessions) {
    if (inUse.has(sessionId)) continue;
    const since = idleSince.get(sessionId);
    // Local Browser Rendering keeps listing a connection after its print
    // disconnected; one that started before this isolate released the
    // session is that stale one.
    const stale =
      since !== undefined &&
      new Date(connectionStartTime ?? Number.NaN).getTime() < since;
    if (connectionId && !stale) {
      idleSince.delete(sessionId);
      continue;
    }
    if (since === undefined) idleSince.set(sessionId, now);
    else if (now - since >= idleCapMs) expired.push(sessionId);
  }
  await Promise.all(
    expired.map(async id => {
      try {
        const browser = await connectSession(binding, id);
        if (!browser) return;
        // A print may have claimed it while this sweep connected.
        if (inUse.has(id)) {
          browser.disconnect();
          return;
        }
        idleSince.delete(id);
        await browser.close();
      } catch (error) {
        console.warn(`closing idle browser session ${id} failed`, error);
      }
    }),
  );
}
