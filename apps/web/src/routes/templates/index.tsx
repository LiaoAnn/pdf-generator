import {
  type TemplateSummary,
  templateListSchema,
} from '@pdf-generator/contract';
import { createFileRoute, Link } from '@tanstack/react-router';
import { buttonClass } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatTime, orientationLabel } from '@/templates/labels';

export const Route = createFileRoute('/templates/')({
  ssr: false,
  loader: () => api('/api/templates', templateListSchema),
  component: Templates,
});

/** Each template's versions, oldest first; templates in the API's id order. */
function byTemplate(list: TemplateSummary[]): TemplateSummary[][] {
  const groups = new Map<string, TemplateSummary[]>();
  for (const summary of list) {
    groups.set(summary.id, [...(groups.get(summary.id) ?? []), summary]);
  }
  return [...groups.values()];
}

function Templates() {
  const { templates } = Route.useLoaderData();
  const groups = byTemplate(templates);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">樣板</h1>
          <p className="text-muted-foreground text-sm">
            上傳的樣板包。同一個樣板 ID 再上傳一次會變成新版本，舊版本都會保留。
          </p>
        </div>
        <Link to="/templates/upload" className={buttonClass()}>
          上傳樣板包
        </Link>
      </div>
      {groups.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            還沒有樣板。先上傳一個樣板包（zip）。
          </CardContent>
        </Card>
      ) : (
        groups.map(versions => {
          const latest = versions[versions.length - 1];
          if (!latest) return null;
          return (
            <Card key={latest.id}>
              <CardHeader>
                <CardTitle>
                  <Link
                    to="/templates/$id"
                    params={{ id: latest.id }}
                    className="hover:underline">
                    {latest.name}
                  </Link>
                </CardTitle>
                <CardDescription>
                  <code>{latest.id}</code> · 最新版本 v{latest.version} · 共{' '}
                  {versions.length} 個版本 · A4{' '}
                  {orientationLabel(latest.page.orientation)} · 上傳於{' '}
                  {formatTime(latest.createdAt)}
                </CardDescription>
              </CardHeader>
              {latest.description ? (
                <CardContent className="text-sm">
                  {latest.description}
                </CardContent>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}
