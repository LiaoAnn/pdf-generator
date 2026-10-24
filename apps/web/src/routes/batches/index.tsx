import { batchListSchema } from '@pdf-generator/contract';
import { createFileRoute, Link } from '@tanstack/react-router';
import { batchStatusLabel, progressLine } from '@/batches/labels';
import { ProblemCard } from '@/components/problem-card';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ApiProblem, api } from '@/lib/api';
import { formatTime } from '@/templates/labels';

export const Route = createFileRoute('/batches/')({
  ssr: false,
  loader: () => api('/api/batches', batchListSchema),
  component: Batches,
  errorComponent: ({ error }) =>
    error instanceof ApiProblem ? (
      <ProblemCard problem={error} />
    ) : (
      <p>{String(error)}</p>
    ),
});

function Batches() {
  const { batches } = Route.useLoaderData();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">批次</h1>
        <p className="text-muted-foreground text-sm">
          每個批次用同一個樣板版本和種子產生 N 份。點進去看每一份的 PDF 和答案。
        </p>
      </div>
      {batches.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            還沒有批次。
          </CardContent>
        </Card>
      ) : (
        batches.map(batch => (
          <Card key={batch.id}>
            <CardHeader>
              <CardTitle>
                <Link
                  to="/batches/$id"
                  params={{ id: batch.id }}
                  className="hover:underline">
                  {batch.templateId} v{batch.templateVersion} · {batch.count} 份
                </Link>{' '}
                <span className="text-muted-foreground text-sm font-normal">
                  {batchStatusLabel[batch.status]}
                </span>
              </CardTitle>
              <CardDescription>
                {progressLine(batch)} · 種子 <code>{batch.seed}</code> · 建立於{' '}
                {formatTime(batch.createdAt)}
              </CardDescription>
            </CardHeader>
          </Card>
        ))
      )}
    </div>
  );
}
