import { batchSchema, fixtureListSchema } from '@pdf-generator/contract';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import {
  batchStatusLabel,
  fixtureStatusLabel,
  isFinished,
  progressLine,
} from '@/batches/labels';
import { ProblemCard } from '@/components/problem-card';
import { buttonClass } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiProblem, api } from '@/lib/api';
import { formatTime } from '@/templates/labels';

export const Route = createFileRoute('/batches/$id/')({
  ssr: false,
  loader: async ({ params }) => {
    const base = `/api/batches/${encodeURIComponent(params.id)}`;
    const [batch, list] = await Promise.all([
      api(base, batchSchema),
      api(`${base}/fixtures`, fixtureListSchema),
    ]);
    return { batch, fixtures: list.fixtures };
  },
  component: BatchPage,
  errorComponent: ({ error }) =>
    error instanceof ApiProblem ? (
      <ProblemCard problem={error} />
    ) : (
      <p>{String(error)}</p>
    ),
});

function BatchPage() {
  const { batch, fixtures } = Route.useLoaderData();
  const router = useRouter();
  const finished = isFinished(batch);

  // A batch still running is reloaded every few seconds.
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => void router.invalidate(), 3000);
    return () => clearInterval(timer);
  }, [finished, router]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link to="/batches" className="hover:underline">
              批次
            </Link>{' '}
            / <code>{batch.id}</code>
          </p>
          <h1 className="text-2xl font-semibold">
            {batch.templateId} v{batch.templateVersion} · {batch.count} 份 ·{' '}
            {batchStatusLabel[batch.status]}
          </h1>
          <p className="text-muted-foreground text-sm">
            {progressLine(batch)} · 種子 <code>{batch.seed}</code> · 建立於{' '}
            {formatTime(batch.createdAt)}
            {batch.rerunOf ? (
              <>
                {' '}
                · 重做自{' '}
                <Link
                  to="/batches/$id"
                  params={{ id: batch.rerunOf }}
                  className="hover:underline">
                  <code>{batch.rerunOf.slice(0, 8)}</code>
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {finished ? (
          <a
            href={`/api/batches/${encodeURIComponent(batch.id)}/zip`}
            className={buttonClass('outline')}>
            下載整批 zip
          </a>
        ) : null}
      </div>
      <Card>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left">
              <tr>
                <th className="py-1 font-normal">序號</th>
                <th className="py-1 font-normal">狀態</th>
                <th className="py-1 font-normal">自我檢查</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.map(fixture => (
                <tr key={fixture.index} className="border-t">
                  <td className="py-1">
                    {fixture.status === 'completed' ? (
                      <Link
                        to="/batches/$id/$fixture"
                        params={{
                          id: batch.id,
                          fixture: String(fixture.index),
                        }}
                        className="font-mono hover:underline">
                        {String(fixture.index).padStart(4, '0')}
                      </Link>
                    ) : (
                      <span className="font-mono">
                        {String(fixture.index).padStart(4, '0')}
                      </span>
                    )}
                  </td>
                  <td className="py-1">
                    {fixtureStatusLabel[fixture.status]}
                    {fixture.error ? (
                      <span className="text-destructive">
                        ：{fixture.error}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1">
                    {fixture.check === undefined
                      ? '—'
                      : fixture.check.passed
                        ? '通過'
                        : `未過（${fixture.check.differences} 處差異）`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
