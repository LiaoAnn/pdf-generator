import puppeteer from '@cloudflare/puppeteer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openBrowser } from './lib.ts';

vi.mock('@cloudflare/puppeteer', () => ({
  default: { launch: vi.fn(), connect: vi.fn() },
}));

const binding = {} as Parameters<typeof puppeteer.launch>[0];

function browser(id: string) {
  return {
    sessionId: vi.fn(() => id),
    close: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Regression: opting out of sessions must still close resources rather than
// leaving a kept-alive browser running after every ordinary request.
test('ordinary browser ownership launches without keep_alive and release closes it', async () => {
  const launched = browser('ephemeral');
  vi.mocked(puppeteer.launch).mockResolvedValue(launched as never);
  const opened = await openBrowser(binding);
  expect(puppeteer.launch).toHaveBeenCalledExactlyOnceWith(binding);
  expect(opened.browser).toBe(launched);
  expect(opened.sessionId).toBeUndefined();
  await opened.release();
  expect(launched.close).toHaveBeenCalledTimes(1);
  expect(launched.disconnect).not.toHaveBeenCalled();
});

test.each([
  ['default keep alive (60 s idle cap)', undefined, 60_000],
  ['caller keep alive', 90_000, 90_000],
] as const)(
  'new session uses %s and release disconnects without destroying the browser',
  async (_name, keepAliveMs, expected) => {
    const launched = browser('kept-session');
    vi.mocked(puppeteer.launch).mockResolvedValue(launched as never);
    const opened = await openBrowser(binding, {
      session: 'new',
      ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
    });
    expect(puppeteer.launch).toHaveBeenCalledExactlyOnceWith(binding, {
      keep_alive: expected,
    });
    expect(opened.browser).toBe(launched);
    expect(opened.sessionId).toBe('kept-session');
    await opened.release();
    expect(launched.disconnect).toHaveBeenCalledTimes(1);
    expect(launched.close).not.toHaveBeenCalled();
  },
);

test('a ready session reconnects immediately without launching or waiting', async () => {
  const connected = browser('existing');
  vi.mocked(puppeteer.connect).mockResolvedValue(connected as never);
  const opened = await openBrowser(binding, { session: 'existing' });
  expect(puppeteer.connect).toHaveBeenCalledExactlyOnceWith(
    binding,
    'existing',
  );
  expect(puppeteer.launch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(opened.sessionId).toBe('existing');
  expect(opened.browser).toBe(connected);
  await opened.release();
  expect(connected.disconnect).toHaveBeenCalledTimes(1);
  expect(connected.close).not.toHaveBeenCalled();
});

// Regression: an immediate reconnect can fail while the preceding disconnect
// is settling (T03 §6.4); giving up early launches an expensive replacement.
test('reconnect retries at 1000ms then 2000ms and retains the original session on third-attempt success', async () => {
  const connected = browser('existing');
  vi.mocked(puppeteer.connect)
    .mockRejectedValueOnce(new Error('may still be in use'))
    .mockRejectedValueOnce(new Error('not ready yet'))
    .mockResolvedValueOnce(connected as never);
  const opening = openBrowser(binding, { session: 'existing' });
  await vi.advanceTimersByTimeAsync(0);
  expect(puppeteer.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(puppeteer.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(puppeteer.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(puppeteer.connect).toHaveBeenCalledTimes(2);
  expect(puppeteer.launch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  const opened = await opening;
  expect(vi.mocked(puppeteer.connect).mock.calls).toEqual([
    [binding, 'existing'],
    [binding, 'existing'],
    [binding, 'existing'],
  ]);
  expect(puppeteer.launch).not.toHaveBeenCalled();
  expect(opened.sessionId).toBe('existing');
  await opened.release();
  expect(connected.disconnect).toHaveBeenCalledTimes(1);
  expect(connected.close).not.toHaveBeenCalled();
});

test.each([undefined, 75_000])(
  'three failed reconnects launch a replacement with keep_alive (override %j)',
  async keepAliveMs => {
    const replacement = browser('replacement');
    vi.mocked(puppeteer.connect).mockRejectedValue(new Error('session gone'));
    vi.mocked(puppeteer.launch).mockResolvedValue(replacement as never);
    const opening = openBrowser(binding, {
      session: 'deleted',
      ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(puppeteer.connect).toHaveBeenCalledTimes(2);
    expect(puppeteer.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const opened = await opening;
    expect(puppeteer.connect).toHaveBeenCalledTimes(3);
    expect(puppeteer.launch).toHaveBeenCalledExactlyOnceWith(binding, {
      keep_alive: keepAliveMs ?? 60_000,
    });
    expect(opened.browser).toBe(replacement);
    expect(opened.sessionId).toBe('replacement');
    await opened.release();
    expect(replacement.disconnect).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
