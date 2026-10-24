import puppeteer from '@cloudflare/puppeteer';
import { GroundTruthError } from '@pdf-generator/ground-truth';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import worker from './index.ts';
import { RenderError, renderPdf } from './lib.ts';

vi.mock('@cloudflare/puppeteer', () => ({
  default: { launch: vi.fn(), connect: vi.fn() },
}));
vi.mock('./lib.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib.ts')>()),
  renderPdf: vi.fn(),
}));

const token = 'session-cleanup-token';
const env = { BROWSER: {}, PRINT_TOKEN: token, PACK_FILES: {} } as never;

function browser(id: string) {
  return {
    sessionId: vi.fn(() => id),
    close: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}

function print(session?: string) {
  return worker.fetch(
    new Request('https://print.test/print', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(session ? { 'X-Browser-Session': session } : {}),
      },
      body: JSON.stringify({
        html: '<p>x</p>',
        page: { size: 'A4', orientation: 'portrait' },
      }),
    }) as never,
    env,
  );
}

// Auth hashes the token with real (non-timer) async work, so the first
// connect happens a few real ticks after the request starts.
async function untilConnects(count: number) {
  for (let tick = 0; tick < 1000; tick++) {
    if (vi.mocked(puppeteer.connect).mock.calls.length >= count) return;
    await new Promise(resolve => setImmediate(resolve));
  }
}

function close(id: string, authorization = `Bearer ${token}`) {
  return worker.fetch(
    new Request(`https://print.test/session/${id}`, {
      method: 'DELETE',
      headers: { Authorization: authorization },
    }) as never,
    env,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// Regression: a 422 without the header leaves the caller unable to close the
// kept session it just opened (a Chrome left running per failed first print).
test.each([
  [
    'a render error',
    new RenderError('text_missing', 'Text is missing', ['page 1: x']),
    'text_missing',
  ],
  [
    'a ground-truth error',
    new GroundTruthError(['no blocks']),
    'ground_truth_invalid',
  ],
])(
  '%s on a kept session answers 422 naming the session and only disconnects',
  async (_name, error, code) => {
    const kept = browser('kept-session');
    vi.mocked(puppeteer.launch).mockResolvedValue(kept as never);
    vi.mocked(renderPdf).mockRejectedValue(error);
    const response = await print('new');
    expect(response.status).toBe(422);
    expect(response.headers.get('X-Browser-Session')).toBe('kept-session');
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe(code);
    expect(kept.disconnect).toHaveBeenCalledTimes(1);
    expect(kept.close).not.toHaveBeenCalled();
  },
);

// Regression: the 422 header must also come back when reusing an id.
test('a render error on a reused session names that session', async () => {
  const kept = browser('existing');
  vi.mocked(puppeteer.connect).mockResolvedValue(kept as never);
  vi.mocked(renderPdf).mockRejectedValue(
    new RenderError('text_missing', 'Text is missing'),
  );
  const response = await print('existing');
  expect(response.status).toBe(422);
  expect(response.headers.get('X-Browser-Session')).toBe('existing');
  expect(kept.close).not.toHaveBeenCalled();
});

// Regression: a one-request browser has no session to name, so the 422 must
// not invent the header (callers would try to close a dead browser).
test('a render error without a session answers 422 with no session header and closes the browser', async () => {
  const once = browser('ephemeral');
  vi.mocked(puppeteer.launch).mockResolvedValue(once as never);
  vi.mocked(renderPdf).mockRejectedValue(
    new RenderError('text_missing', 'Text is missing'),
  );
  const response = await print();
  expect(response.status).toBe(422);
  expect(response.headers.has('X-Browser-Session')).toBe(false);
  expect(once.close).toHaveBeenCalledTimes(1);
});

// Regression: an unexpected failure never tells the caller the session id, so
// only closing the browser stops it from running until keep_alive expires.
test.each([
  ['a new session', 'new'],
  ['an existing session', 'existing'],
])(
  'an unexpected error on %s closes the kept browser',
  async (_name, session) => {
    const kept = browser('kept-session');
    vi.mocked(puppeteer.launch).mockResolvedValue(kept as never);
    vi.mocked(puppeteer.connect).mockResolvedValue(kept as never);
    vi.mocked(renderPdf).mockRejectedValue(new Error('boom'));
    await Promise.resolve(print(session)).catch(() => undefined);
    expect(kept.close).toHaveBeenCalledTimes(1);
  },
);

// Regression: one-request browsers keep closing on an unexpected error.
test('an unexpected error without a session closes the one-request browser', async () => {
  const once = browser('ephemeral');
  vi.mocked(puppeteer.launch).mockResolvedValue(once as never);
  vi.mocked(renderPdf).mockRejectedValue(new Error('boom'));
  await Promise.resolve(print()).catch(() => undefined);
  expect(once.close).toHaveBeenCalledTimes(1);
});

// Regression: successful prints must keep the session for the next request.
test('a successful print on a kept session disconnects without closing it', async () => {
  const kept = browser('kept-session');
  vi.mocked(puppeteer.launch).mockResolvedValue(kept as never);
  vi.mocked(renderPdf).mockResolvedValue({
    pdf: new Uint8Array([1]),
    pageCount: 1,
  } as never);
  const response = await print('new');
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Browser-Session')).toBe('kept-session');
  expect(kept.disconnect).toHaveBeenCalledTimes(1);
  expect(kept.close).not.toHaveBeenCalled();
});

// Regression: waiting before the first attempt would slow every ordinary close.
test('deleting a reachable session closes it at once without waiting', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const kept = browser('existing');
  vi.mocked(puppeteer.connect).mockResolvedValue(kept as never);
  const response = await close('existing');
  expect(response.status).toBe(204);
  expect(puppeteer.connect).toHaveBeenCalledExactlyOnceWith({}, 'existing');
  expect(kept.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

// Regression: an immediate reconnect after a disconnect failed 2 of 3 times on
// the real platform, so one failed connect must not leave the session open.
test('deleting a session retries the reconnect at 1000ms then 2000ms and closes it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const kept = browser('existing');
  vi.mocked(puppeteer.connect)
    .mockRejectedValueOnce(new Error('may still be in use'))
    .mockRejectedValueOnce(new Error('not ready yet'))
    .mockResolvedValueOnce(kept as never);
  const deleting = close('existing');
  await untilConnects(1);
  expect(puppeteer.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(puppeteer.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(puppeteer.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(puppeteer.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  const response = await deleting;
  expect(response.status).toBe(204);
  expect(puppeteer.connect).toHaveBeenCalledTimes(3);
  expect(kept.close).toHaveBeenCalledTimes(1);
  expect(puppeteer.launch).not.toHaveBeenCalled();
});

// Regression: giving up before the third attempt reports a live session as
// gone; retrying forever (or launching a replacement) never answers 404.
test('deleting a session answers session_not_found only after three failed attempts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.mocked(puppeteer.connect).mockRejectedValue(new Error('session gone'));
  const deleting = close('deleted');
  await untilConnects(1);
  await vi.advanceTimersByTimeAsync(2999);
  expect(puppeteer.connect).toHaveBeenCalledTimes(2);
  let settled = false;
  void deleting.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const response = await deleting;
  expect(response.status).toBe(404);
  expect(
    ((await response.json()) as { error: { code: string } }).error.code,
  ).toBe('session_not_found');
  expect(puppeteer.connect).toHaveBeenCalledTimes(3);
  expect(puppeteer.launch).not.toHaveBeenCalled();
});
