// In a kept-alive browser session, the prints of one batch share a browser
// context; the print Worker remembers each shared context's id per session.
// What it remembers for a session goes when the session ends, by whichever
// path it ends, and only that session's.
import puppeteer, { type ActiveSession } from '@cloudflare/puppeteer';
import { afterEach, expect, test, vi } from 'vitest';
import { fakeFetch } from './fake-fetch.ts';
import worker from './index.ts';
import { renderPdf } from './lib.ts';
import {
  closeIdleSessions,
  closeSession,
  openBrowser,
  sharedContextIds,
} from './session.ts';

vi.mock('@cloudflare/puppeteer', () => ({
  default: { launch: vi.fn(), connect: vi.fn(), sessions: vi.fn() },
}));

const binding = {} as never;
const token = 'session-contexts-token';
const idleCapMs = 60_000;

function browser(id: string) {
  return {
    sessionId: vi.fn(() => id),
    close: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}

/** Remembers a shared context for `session` under `key`, as a print would. */
function remember(session: string, key = 'batch') {
  sharedContextIds(session).set(key, Promise.resolve(`${session}-context`));
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(puppeteer.launch).mockReset();
  vi.mocked(puppeteer.connect).mockReset();
  vi.mocked(puppeteer.sessions).mockReset();
});

// Regression (T07-5 review): the map kept one entry per batch session until
// the isolate was evicted.
test('closing a session forgets its shared contexts and keeps other sessions', async () => {
  remember('closed');
  remember('other');
  vi.mocked(puppeteer.connect).mockResolvedValue(browser('closed') as never);
  expect(await closeSession(binding, 'closed')).toBe(true);
  expect(sharedContextIds('closed').size).toBe(0);
  expect([...sharedContextIds('other').keys()]).toEqual(['batch']);
});

test('DELETE /session/<id> forgets the session’s shared contexts', async () => {
  remember('routed');
  const routed = browser('routed');
  vi.mocked(puppeteer.connect).mockResolvedValue(routed as never);
  const response = await worker.fetch(
    new Request('https://print.test/session/routed', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }) as never,
    { BROWSER: binding, PRINT_TOKEN: token, PACK_FILES: {} } as never,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never,
  );
  expect(response.status).toBe(204);
  expect(routed.close).toHaveBeenCalled();
  expect(sharedContextIds('routed').size).toBe(0);
});

test('discarding a kept session forgets its shared contexts', async () => {
  vi.mocked(puppeteer.launch).mockResolvedValue(browser('discarded') as never);
  const opened = await openBrowser(binding, { session: 'new' });
  remember('discarded');
  await opened.discard();
  expect(sharedContextIds('discarded').size).toBe(0);
});

test('the idle sweep forgets the shared contexts of a session it closes', async () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 4, 12) });
  vi.mocked(puppeteer.launch).mockResolvedValue(browser('idle') as never);
  const opened = await openBrowser(binding, { session: 'new' });
  remember('idle');
  await opened.release();
  const listed: ActiveSession[] = [{ sessionId: 'idle', startTime: 0 }];
  vi.mocked(puppeteer.sessions).mockResolvedValue(listed);
  const reconnected = browser('idle');
  vi.mocked(puppeteer.connect).mockResolvedValue(reconnected as never);
  vi.setSystemTime(Date.now() + idleCapMs);
  await closeIdleSessions(binding);
  expect(reconnected.close).toHaveBeenCalled();
  expect(sharedContextIds('idle').size).toBe(0);
});

test('the idle sweep forgets the shared contexts of a session no longer listed', async () => {
  vi.mocked(puppeteer.launch).mockResolvedValue(browser('gone') as never);
  const opened = await openBrowser(binding, { session: 'new' });
  remember('gone');
  await opened.release();
  // It ended elsewhere: its keep-alive ran out, or another isolate closed it.
  vi.mocked(puppeteer.sessions).mockResolvedValue([]);
  await closeIdleSessions(binding);
  expect(sharedContextIds('gone').size).toBe(0);
});

// The prints of a session share one context through this map: two prints
// create it once, and once the session ended a print creates a new one.
test('prints share a context per session and key until the session ends', async () => {
  const failure = new Error('navigation stopped by the test');
  const page = {
    ...fakeFetch(),
    goto: vi.fn(async () => {
      throw failure;
    }),
    close: vi.fn(async () => {}),
  };
  const context = {
    id: 'shared-context-1',
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const createBrowserContext = vi.fn(async () => context);
  const tab = {
    createBrowserContext,
    browserContexts: () => [context],
  } as never;
  const store = { put: vi.fn(async () => ({})), delete: vi.fn(async () => {}) };
  const print = () =>
    renderPdf(
      tab,
      {
        html: '<p data-gt="text">x</p>',
        page: { size: 'A4', orientation: 'portrait' },
      },
      {
        assetOrigin: 'https://print-assets.example.test',
        store,
        sharedContext: { session: 'printing', key: 'batch' },
      },
    );
  await expect(print()).rejects.toBe(failure);
  await expect(print()).rejects.toBe(failure);
  expect(createBrowserContext).toHaveBeenCalledTimes(1);
  expect(await sharedContextIds('printing').get('batch')).toBe(
    'shared-context-1',
  );
  vi.mocked(puppeteer.connect).mockResolvedValue(browser('printing') as never);
  await closeSession(binding, 'printing');
  expect(sharedContextIds('printing').size).toBe(0);
  await expect(print()).rejects.toBe(failure);
  expect(createBrowserContext).toHaveBeenCalledTimes(2);
});
