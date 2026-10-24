import { readFileSync } from 'node:fs';
import type { Browser } from '@cloudflare/puppeteer';
import { afterEach, expect, test, vi } from 'vitest';
import { fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

const request = {
  html: '<!doctype html><html><body><p data-gt="text">PACK</p></body></html>',
  page: { size: 'A4', orientation: 'portrait' },
  pack: {
    template: 'templates/report.hbs',
    files: {
      'assets/logo.svg': Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ).toString('base64'),
    },
  },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

// Route callers cannot discover the transient id. The public render hook is
// the boundary where we can see storage while navigation is active and after
// settlement, without coupling the test to R2 key layout or id generation.
test.each([
  'success',
  'font_not_loaded',
  'row_fragmented',
  'pagination_timeout',
  'inspect',
  'pdf',
  'goto',
] as const)(
  'keeps document/files available during navigation and deletes every write after %s',
  async stage => {
    vi.useFakeTimers();
    const stored = new Map<string, Uint8Array | string>();
    const written: string[] = [];
    const deleted: string[] = [];
    const store = {
      put: vi.fn(async (key: string, value: Uint8Array | string) => {
        written.push(key);
        stored.set(key, value);
      }),
      delete: vi.fn(async (keys: string[]) => {
        await Promise.resolve();
        for (const key of keys) {
          deleted.push(key);
          stored.delete(key);
        }
      }),
    };
    const failure = new Error(`${stage} failed`);
    let availableAtNavigation = 0;
    const page = {
      ...fakeFetch(),
      goto: vi.fn(async (_url: string) => {
        availableAtNavigation = stored.size;
        if (stage === 'goto') throw failure;
      }),
      setContent: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {
        if (stage === 'pagination_timeout') return new Promise<never>(() => {});
        return {
          pageCount: 1,
          unloadedFaces:
            stage === 'font_not_loaded' ? ['Report Sans 400: error'] : [],
          fragmentedRows: stage === 'row_fragmented' ? ['page 1: row'] : [],
        };
      }),
      pdf: vi.fn(async () => {
        if (stage === 'pdf') throw failure;
        return new Uint8Array(
          readFileSync(
            new URL('./test-fixtures/blank-1-pages.pdf', import.meta.url),
          ),
        );
      }),
      close: vi.fn(async () => {}),
    };
    const browser = {
      target: () => fakeFetch(),
      newPage: async () => page,
    } as unknown as Browser;
    const rendering = renderPdf(browser, request, {
      assetOrigin: 'https://print-assets.example.test',
      store,
      timeoutMs: 25,
      inspect: async () => {
        if (stage === 'inspect') throw failure;
        return 'inspected';
      },
    });
    const outcome = rendering.then(
      value => value,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(25);
    const result = await outcome;
    if (stage === 'success')
      expect(result).toMatchObject({ pageCount: 1, inspected: 'inspected' });
    else if (['inspect', 'pdf', 'goto'].includes(stage))
      expect(result).toBe(failure);
    else {
      expect(result).toBeInstanceOf(RenderError);
      expect(result).toMatchObject({ code: stage });
    }
    expect.soft(availableAtNavigation).toBeGreaterThanOrEqual(2);
    expect.soft(written.length).toBeGreaterThanOrEqual(2);
    expect.soft(new Set(deleted)).toEqual(new Set(written));
    expect.soft(stored.size).toBe(0);
    expect.soft(page.setContent).not.toHaveBeenCalled();
    const url = new URL(
      page.goto.mock.calls[0]?.[0] ?? 'https://missing.invalid',
    );
    expect(url.origin).toBe('https://print-assets.example.test');
    expect(url.pathname).toMatch(/^\/pack\/[^/]+\/templates\/report\.hbs$/);
  },
);
