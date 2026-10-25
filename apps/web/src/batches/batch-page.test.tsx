import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { Route } from '../routes/batches/$id/index';

afterEach(() => vi.unstubAllGlobals());

test('keeps the raw failure and Chinese guidance in the failed fixture row when rendering the batch route', async () => {
  const batchId = 'batch-page-errors';
  const raw =
    'print 422 page_count_mismatch: The PDF has a different number of pages than Paged.js made';
  const explanation =
    '印出來的 PDF 頁數和 Paged.js 排出的頁數不同，標準答案的頁碼會對不上。';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === `/api/batches/${batchId}`) {
        return Response.json({
          id: batchId,
          templateId: 'monthly-report',
          templateVersion: 1,
          count: 2,
          seed: 'route-error-regression',
          status: 'completed',
          progress: {
            completed: 1,
            failed: 1,
            checkPassed: 1,
            checkFailed: 0,
          },
          createdAt: '2026-10-25T00:00:00Z',
          finishedAt: '2026-10-25T00:01:00Z',
        });
      }
      if (path === `/api/batches/${batchId}/fixtures`) {
        return Response.json({
          batchId,
          fixtures: [
            { index: 0, status: 'failed', error: raw },
            {
              index: 1,
              status: 'completed',
              check: { passed: true, differences: 0 },
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    }),
  );

  const root = createRootRoute({ component: Outlet });
  const route = Route.update({
    id: '/batches/$id/',
    path: '/batches/$id/',
    getParentRoute: () => root,
    // Node SSR otherwise skips this client-only route's real loader.
    ssr: true,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [`/batches/${batchId}`],
    }),
  });
  await router.load();
  const markup = renderToString(<RouterProvider router={router} />);
  const tbody = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? '';
  const rows = tbody.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  expect(rows).toHaveLength(2);
  const failedRow = rows.find(row => row.includes('0000'));
  const completedRow = rows.find(row => row.includes('0001'));
  expect(failedRow).toBeDefined();
  expect(completedRow).toBeDefined();
  expect(failedRow).toContain(raw);
  expect(failedRow).toContain(explanation);
  expect(completedRow).not.toContain(raw);
  expect(completedRow).not.toContain(explanation);
});
