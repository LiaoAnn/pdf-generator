import puppeteer, { type ActiveSession } from '@cloudflare/puppeteer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { renderPdf as renderPdfType } from './lib.ts';

vi.mock('@cloudflare/puppeteer', () => ({
  default: { launch: vi.fn(), connect: vi.fn(), sessions: vi.fn() },
}));
vi.mock('./lib.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib.ts')>()),
  renderPdf: vi.fn(),
}));

const token = 'idle-sweep-token';
const env = { BROWSER: {}, PRINT_TOKEN: token, PACK_FILES: {} } as never;
const capMs = 60_000;

type Worker = typeof import('./index.ts').default;

let worker: Worker;
let renderPdf: typeof renderPdfType;
// The sessions the platform lists, and every browser a connect handed out.
let listed: ActiveSession[];
let connected: ReturnType<typeof browser>[];

function browser(id: string) {
  return {
    id,
    sessionId: vi.fn(() => id),
    close: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}

const idle = (sessionId: string): ActiveSession => ({
  sessionId,
  startTime: 0,
});
const inUse = (
  sessionId: string,
  connectionStartTime: string | number = '1970-01-01T00:00:00.000Z',
): ActiveSession => ({
  sessionId,
  startTime: 0,
  connectionId: 'connection-1',
  // Miniflare returns epoch ms despite the SDK declaring a string.
  connectionStartTime: connectionStartTime as string,
});

/** A Workers `ExecutionContext` that lets a test wait for the sweep. */
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    }),
    passThroughOnException: vi.fn(),
    async settled() {
      for (let seen = 0; seen < pending.length; ) {
        seen = pending.length;
        await Promise.allSettled(pending);
      }
      return Promise.allSettled(pending);
    },
  };
}

function printRequest(authorization: string, session?: string) {
  return new Request('https://print.test/print', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      ...(session ? { 'X-Browser-Session': session } : {}),
    },
    body: JSON.stringify({
      html: '<p>x</p>',
      page: { size: 'A4', orientation: 'portrait' },
    }),
  });
}

function startPrint(ctx: ReturnType<typeof makeCtx>, session?: string) {
  return worker.fetch(
    printRequest(`Bearer ${token}`, session) as never,
    env,
    ctx as never,
  );
}

/** One finished print (default: a one-request browser) and its sweep. */
async function print(session?: string) {
  const ctx = makeCtx();
  const response = await startPrint(ctx, session);
  expect(response.status).toBe(200);
  await ctx.settled();
  return ctx;
}

/** Prints while the platform lists `sessions`. */
async function sweepSeeing(...sessions: ActiveSession[]) {
  listed = sessions;
  await print();
}

/** The ids of sessions a sweep connected to and closed. */
const closedIds = () =>
  connected.filter(b => b.close.mock.calls.length > 0).map(b => b.id);

const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    now: 1_800_000_000_000,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  worker = (await import('./index.ts')).default;
  renderPdf = (await import('./lib.ts')).renderPdf;
  listed = [];
  connected = [];
  vi.mocked(puppeteer.sessions).mockImplementation(async () => listed);
  vi.mocked(puppeteer.connect).mockImplementation((async (
    _binding: unknown,
    id: string,
  ) => {
    const b = browser(id);
    connected.push(b);
    return b;
  }) as never);
  vi.mocked(puppeteer.launch).mockImplementation((async (
    _binding: unknown,
    options?: unknown,
  ) => browser(options ? 'kept' : 'ephemeral')) as never);
  vi.mocked(renderPdf).mockResolvedValue({
    pdf: new Uint8Array([1]),
    pageCount: 1,
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Regression: Miniflare ignores keep_alive, so a batch whose caller never
// closed its session left a Chrome running forever. Also guards the clock:
// merely seeing a released session must not restart it, and the cap must be
// 60 s, not the old 10 min.
test('a print closes a session this Worker released once it has been idle 60 s, and still answers normally', async () => {
  await print('new');
  expect(closedIds()).toEqual([]);

  await elapse(30_000);
  await sweepSeeing(idle('kept'));
  expect(closedIds()).toEqual([]);

  await elapse(capMs - 30_000 - 1);
  await sweepSeeing(idle('kept'));
  expect(closedIds()).toEqual([]);

  await elapse(1);
  listed = [idle('kept')];
  const ctx = makeCtx();
  const response = await startPrint(ctx);
  await ctx.settled();
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/pdf');
  expect(ctx.waitUntil).toHaveBeenCalled();
  expect(closedIds()).toEqual(['kept']);
  expect(puppeteer.connect).toHaveBeenCalledWith({}, 'kept');
});

// Regression: closing on first sight would kill sessions of callers that
// just launched them elsewhere; using the platform's startTime would close
// every old-but-busy session at once.
test('a session this Worker never released is closed only by a sweep 60 s after it was first seen idle', async () => {
  const old = { ...idle('foreign'), startTime: 1_000 };
  await sweepSeeing(old);
  expect(closedIds()).toEqual([]);

  await elapse(capMs - 1);
  await sweepSeeing(old);
  expect(closedIds()).toEqual([]);

  await elapse(1);
  await sweepSeeing(old);
  expect(closedIds()).toEqual(['foreign']);
});

// Regression: a session with a live connection is working, however long it
// has existed; once it goes idle it gets a full 60 s again.
test('a session seen with a connectionId is never closed and restarts its idle clock', async () => {
  await sweepSeeing(inUse('busy'));
  await elapse(50_000);
  await sweepSeeing(inUse('busy'));
  expect(closedIds()).toEqual([]);

  await elapse(10_000);
  await sweepSeeing(idle('busy'));
  expect(closedIds()).toEqual([]);

  await elapse(49_999);
  await sweepSeeing(idle('busy'));
  expect(closedIds()).toEqual([]);

  await elapse(10_001);
  await sweepSeeing(idle('busy'));
  expect(closedIds()).toEqual(['busy']);
});

// Regression: treating Miniflare's lingering connectionId as live leaks a
// released browser forever; parsing only ISO strings misses local epoch ms.
test.each(['epoch-ms number', 'ISO string'] as const)(
  'a released session with a stale connection (%s) closes at 60 s, not 59,999 ms',
  async format => {
    await print('new');
    const startedAt = Date.now() - 1;
    const staleConnection = inUse(
      'kept',
      format === 'epoch-ms number'
        ? startedAt
        : new Date(startedAt).toISOString(),
    );

    await elapse(capMs - 1);
    await sweepSeeing(staleConnection);
    expect(closedIds()).toEqual([]);

    await elapse(1);
    await sweepSeeing(staleConnection);
    expect(closedIds()).toEqual(['kept']);
  },
);

// Regression: classifying a connection starting at or after release as stale
// kills another caller's browser; retaining the old clock closes it too soon.
test.each([
  ['epoch-ms number', 0],
  ['epoch-ms number', 1],
  ['ISO string', 0],
  ['ISO string', 1],
] as const)(
  'a connection (%s) starting %i ms after release stays live and resets the idle clock',
  async (format, offsetMs) => {
    await print('new');
    const startedAt = Date.now() + offsetMs;
    const liveConnection = inUse(
      'kept',
      format === 'epoch-ms number'
        ? startedAt
        : new Date(startedAt).toISOString(),
    );

    await elapse(capMs);
    await sweepSeeing(liveConnection);
    expect(closedIds()).toEqual([]);

    await elapse(capMs);
    await sweepSeeing(liveConnection);
    expect(closedIds()).toEqual([]);

    await sweepSeeing(idle('kept'));
    expect(closedIds()).toEqual([]);
    await elapse(capMs - 1);
    await sweepSeeing(idle('kept'));
    expect(closedIds()).toEqual([]);

    await elapse(1);
    await sweepSeeing(idle('kept'));
    expect(closedIds()).toEqual(['kept']);
  },
);

// Regression: a batch that keeps reusing its session must never lose it
// because the clock still counted from the session's first release.
test('reusing a session in a print restarts its idle clock', async () => {
  await print('new');
  await elapse(50_000);
  await print('kept');
  await elapse(50_000);
  await sweepSeeing(idle('kept'));
  expect(closedIds()).toEqual([]);

  await elapse(10_000);
  await sweepSeeing(idle('kept'));
  expect(closedIds()).toEqual(['kept']);
});

// Regression: the list can show no connectionId for a session a print has
// opened but not yet connected a tab to; closing it would kill the print.
test('a session in use by a print is not closed even when listed without a connectionId', async () => {
  await print('new');
  await elapse(100_000);
  listed = [idle('kept')];
  let finish: () => void = () => {};
  vi.mocked(renderPdf).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () =>
          resolve({ pdf: new Uint8Array([1]), pageCount: 1 } as never);
      }),
  );
  const longCtx = makeCtx();
  const longPrint = startPrint(longCtx, 'kept');
  for (let tick = 0; tick < 1000; tick++) {
    if (vi.mocked(renderPdf).mock.calls.length > 0) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(renderPdf).toHaveBeenCalledTimes(1);

  await print();
  expect(closedIds()).toEqual([]);

  finish();
  expect((await longPrint).status).toBe(200);
  await longCtx.settled();
  expect(closedIds()).toEqual([]);

  // Released again, it ages normally.
  await elapse(capMs);
  await print();
  expect(closedIds()).toEqual(['kept']);
});

// Regression: a failing sweep must never turn a good print into a 500 or an
// unhandled rejection in waitUntil.
test('a failing sessions() call is swallowed and the print still succeeds', async () => {
  vi.mocked(puppeteer.sessions).mockRejectedValue(new Error('api down'));
  const ctx = makeCtx();
  const response = await startPrint(ctx);
  expect(response.status).toBe(200);
  expect(ctx.waitUntil).toHaveBeenCalled();
  const outcomes = await ctx.settled();
  expect(outcomes.every(o => o.status === 'fulfilled')).toBe(true);
});

// Regression: one session that won't close must not shield the others or
// fail the print.
test('a failing close is swallowed and the remaining idle sessions are still closed', async () => {
  await sweepSeeing(idle('stuck'), idle('other'));
  await elapse(capMs);
  vi.mocked(puppeteer.connect).mockImplementation((async (
    _binding: unknown,
    id: string,
  ) => {
    const b = browser(id);
    if (id === 'stuck') b.close.mockRejectedValue(new Error('close failed'));
    connected.push(b);
    return b;
  }) as never);
  listed = [idle('stuck'), idle('other')];
  const ctx = makeCtx();
  const response = await startPrint(ctx);
  expect(response.status).toBe(200);
  const outcomes = await ctx.settled();
  expect(outcomes.every(o => o.status === 'fulfilled')).toBe(true);
  expect(ctx.waitUntil).toHaveBeenCalled();
  expect(closedIds()).toContain('other');
});

// Regression: sweeping before the bearer check would let anyone without the
// token make the Worker list and close browser sessions.
test('an unauthorized print answers 401 and does not sweep', async () => {
  const ctx = makeCtx();
  const response = await worker.fetch(
    printRequest('Bearer wrong-token') as never,
    env,
    ctx as never,
  );
  expect(response.status).toBe(401);
  await ctx.settled();
  expect(puppeteer.sessions).not.toHaveBeenCalled();
  expect(ctx.waitUntil).not.toHaveBeenCalled();
});
