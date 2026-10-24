import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  OpenBrowserOptions,
  openBrowser as openBrowserType,
} from './lib.ts';

vi.mock('@cloudflare/puppeteer', () => ({
  default: { launch: vi.fn(), connect: vi.fn() },
}));

const binding = {} as Parameters<typeof puppeteer.launch>[0];
let openBrowser: typeof openBrowserType;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function browser(id: string) {
  return {
    sessionId: vi.fn(() => id),
    close: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}

const kinds = [
  ['one-request', {}],
  ['new kept session', { session: 'new', keepAliveMs: 75_000 }],
  ['replacement', { session: 'gone', keepAliveMs: 80_000 }],
] as const satisfies ReadonlyArray<readonly [string, OpenBrowserOptions]>;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.useFakeTimers();
  openBrowser = (await import('./lib.ts')).openBrowser;
  vi.mocked(puppeteer.connect).mockRejectedValue(new Error('session gone'));
});

afterEach(() => {
  vi.useRealTimers();
});

// Regression: gating only one launch branch still allows concurrent launches
// (and orphaned local Chrome). Every kind must share a FIFO across both branches.
test.each(kinds)(
  'a pending %s launch holds mixed launches in request order until each settles',
  async (_name, options) => {
    const gates = Array.from({ length: 4 }, () => deferred<Browser>());
    for (const gate of gates) {
      vi.mocked(puppeteer.launch).mockImplementationOnce(() => gate.promise);
    }
    const first = openBrowser(binding, options);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);

    const ordinary = openBrowser(binding);
    const kept = openBrowser(binding, { session: 'new', keepAliveMs: 71_000 });
    const replacement = openBrowser(binding, {
      session: 'gone-again',
      keepAliveMs: 72_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);

    const requests = [first, ordinary, kept, replacement];
    const opened = [];
    for (const [index, request] of requests.entries()) {
      const launched = browser(`browser-${index}`);
      gates[index]?.resolve(launched as unknown as Browser);
      opened.push(await request);
      expect(opened[index]?.browser).toBe(launched);
      await vi.advanceTimersByTimeAsync(0);
      expect(puppeteer.launch).toHaveBeenCalledTimes(Math.min(index + 2, 4));
    }
    expect(vi.mocked(puppeteer.launch).mock.calls.slice(1)).toEqual([
      [binding],
      [binding, { keep_alive: 71_000 }],
      [binding, { keep_alive: 72_000 }],
    ]);
    // None of the preceding browsers had to be released to start the next.
    for (const owner of opened) await owner.release();
  },
);

// Regression: a rejected queue tail can poison all later requests, swallow
// the original error, or let multiple waiters launch together on rejection.
test.each(kinds)(
  'a rejected %s launch rejects its caller and admits later launches one at a time',
  async (_name, options) => {
    const failed = deferred<Browser>();
    const second = deferred<Browser>();
    const third = deferred<Browser>();
    vi.mocked(puppeteer.launch)
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const error = new Error('Unable to connect to existing session');
    const first = openBrowser(binding, options);
    const rejected = first.catch(reason => reason);
    await vi.advanceTimersByTimeAsync(3_000);
    const next = openBrowser(binding, { session: 'new' });
    const last = openBrowser(binding);
    await vi.advanceTimersByTimeAsync(0);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);

    failed.reject(error);
    expect(await rejected).toBe(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    second.resolve(browser('second') as unknown as Browser);
    const nextOpened = await next;
    await vi.advanceTimersByTimeAsync(0);
    expect(puppeteer.launch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(puppeteer.launch).mock.calls.slice(1)).toEqual([
      [binding, { keep_alive: 60_000 }],
      [binding],
    ]);
    third.resolve(browser('third') as unknown as Browser);
    const lastOpened = await last;
    await nextOpened.release();
    await lastOpened.release();
  },
);

// Regression: locking all of openBrowser or retaining the lock until release
// stalls reconnects and unrelated renders behind a slow launch or close.
test('reconnect and release complete while another launch is pending', async () => {
  const gate = deferred<Browser>();
  vi.mocked(puppeteer.launch).mockImplementationOnce(() => gate.promise);
  const launching = openBrowser(binding);
  await vi.advanceTimersByTimeAsync(0);
  expect(puppeteer.launch).toHaveBeenCalledTimes(1);

  const connected = browser('existing');
  vi.mocked(puppeteer.connect).mockResolvedValueOnce(connected as never);
  let reconnected = false;
  const reconnecting = openBrowser(binding, { session: 'existing' }).then(
    opened => {
      reconnected = true;
      return opened;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(puppeteer.connect).toHaveBeenCalledExactlyOnceWith(
    binding,
    'existing',
  );
  expect(reconnected).toBe(true);
  const reused = await reconnecting;
  await reused.release();
  expect(connected.disconnect).toHaveBeenCalledTimes(1);

  gate.resolve(browser('launched') as unknown as Browser);
  await (await launching).release();
});
