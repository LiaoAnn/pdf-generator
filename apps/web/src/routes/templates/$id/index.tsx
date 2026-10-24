import { templateListSchema } from '@pdf-generator/contract';
import { createFileRoute, Link } from '@tanstack/react-router';
import { buttonClass } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatTime, orientationLabel } from '@/templates/labels';

export const Route = createFileRoute('/templates/$id/')({
  ssr: false,
  loader: ({ params }) =>
    api(`/api/templates/${encodeURIComponent(params.id)}`, templateListSchema),
  component: Versions,
});

function Versions() {
  const { templates } = Route.useLoaderData();
  const versions = [...templates].reverse();
  const latest = versions[0];
  if (!latest) return null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link to="/templates" className="hover:underline">
              樣板
            </Link>{' '}
            / <code>{latest.id}</code>
          </p>
          <h1 className="text-2xl font-semibold">{latest.name}</h1>
        </div>
        <Link to="/templates/upload" className={buttonClass('outline')}>
          上傳新版本
        </Link>
      </div>
      <Card>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left">
              <tr>
                <th className="py-2 font-medium">版本</th>
                <th className="py-2 font-medium">名稱與說明</th>
                <th className="py-2 font-medium">版面</th>
                <th className="py-2 font-medium">上傳時間</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {versions.map(version => (
                <tr key={version.version} className="border-t align-top">
                  <td className="py-3 font-medium">v{version.version}</td>
                  <td className="py-3">
                    <div>{version.name}</div>
                    {version.description ? (
                      <div className="text-muted-foreground">
                        {version.description}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-3">
                    A4 {orientationLabel(version.page.orientation)}
                  </td>
                  <td className="py-3">{formatTime(version.createdAt)}</td>
                  <td className="py-3">
                    <div className="flex justify-end gap-2">
                      <Link
                        to="/templates/$id/$version"
                        params={{
                          id: version.id,
                          version: String(version.version),
                        }}
                        className={buttonClass('outline')}>
                        預覽
                      </Link>
                      <a
                        href={`/api/templates/${encodeURIComponent(version.id)}/versions/${version.version}/pack.zip`}
                        className={buttonClass('ghost')}>
                        下載 zip
                      </a>
                    </div>
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
