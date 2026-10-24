import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  CDPSessionEvents,
  Page,
} from '@cloudflare/puppeteer';
import { vi } from 'vitest';

// EventEmitter does not await listeners. A held CDP send must not hold the
// navigation/evaluation that caused Chrome to pause a request.
export function fakeFetch() {
  const handlers: ((event: CDPSessionEvents['Fetch.requestPaused']) => void)[] =
    [];
  const send = vi.fn(
    async (
      _method: string,
      _params?: {
        requestId?: string;
        errorReason?: string;
        patterns?: { urlPattern: string }[];
      },
    ): Promise<unknown> => ({}),
  );
  const on = vi.fn(
    (
      event: string,
      handler: (event: CDPSessionEvents['Fetch.requestPaused']) => void,
    ) => {
      if (event === 'Fetch.requestPaused') handlers.push(handler);
    },
  );
  const detach = vi.fn(async () => {});
  const session = { send, on, detach };
  let nextId = 0;
  return {
    send,
    on,
    detach,
    createCDPSession: vi.fn(async () => session as unknown as CDPSession),
    setCacheEnabled: vi.fn(async (_enabled: boolean) => {}),
    pause(url: string, urlFragment?: string) {
      const requestId = `paused-${++nextId}`;
      const event: CDPSessionEvents['Fetch.requestPaused'] = {
        requestId,
        request: {
          url,
          method: 'GET',
          headers: {},
          initialPriority: 'Medium',
          referrerPolicy: 'no-referrer',
          ...(urlFragment === undefined ? {} : { urlFragment }),
        },
        frameId: 'frame',
        resourceType: 'Other',
      };
      for (const handler of handlers) handler(event);
      return requestId;
    },
  };
}

// Only context-owned tabs are valid: a default-context tab has no proxy guard.
export function fakeBrowserContext(page: unknown) {
  const context = {
    newPage: vi.fn(async () => page as Page),
    close: vi.fn(async () => {}),
  } satisfies Pick<BrowserContext, 'newPage' | 'close'>;
  const createBrowserContext = vi.fn(
    async (_options?: BrowserContextOptions) =>
      context as unknown as BrowserContext,
  );
  const target = vi.fn(() => {
    throw new Error('renderPdf must not attach a browser-level Fetch session');
  });
  const newPage = vi.fn(async () => {
    throw new Error('renderPdf must use context.newPage, not browser.newPage');
  });
  return {
    context,
    createBrowserContext,
    target,
    defaultNewPage: newPage,
    browser: { createBrowserContext, target, newPage } as unknown as Browser,
  };
}
