import { templateListSchema } from '@pdf-generator/contract';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PdfPages } from '@/components/pdf-pages';
import { ProblemCard } from '@/components/problem-card';
import { buttonClass } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiProblem, api, problem } from '@/lib/api';
import { orientationLabel } from '@/templates/labels';

export const Route = createFileRoute('/templates/$id/$version')({
  ssr: false,
  loader: async ({ params }) => {
    const { templates } = await api(
      `/api/templates/${encodeURIComponent(params.id)}`,
      templateListSchema,
    );
    const summary = templates.find(t => String(t.version) === params.version);
    if (!summary) {
      throw new ApiProblem(404, {
        code: 'template_not_found',
        message: `No template ${params.id} version ${params.version}.`,
      });
    }
    return summary;
  },
  component: Preview,
  errorComponent: ({ error }) =>
    error instanceof ApiProblem ? (
      <ProblemCard problem={error} />
    ) : (
      <p>{String(error)}</p>
    ),
});

type Printed =
  | { step: 'printing' }
  | { step: 'printed'; pdf: ArrayBuffer; url: string }
  | { step: 'failed'; problem: ApiProblem };

// Printing takes seconds (a browser per preview), so the page shows first
// and the PDF follows.
function usePreview(path: string): Printed {
  const [printed, setPrinted] = useState<Printed>({ step: 'printing' });
  useEffect(() => {
    let url: string | undefined;
    let current = true;
    setPrinted({ step: 'printing' });
    (async () => {
      const response = await fetch(path, { credentials: 'same-origin' });
      if (!response.ok) throw await problem(response);
      const pdf = await response.arrayBuffer();
      url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
      if (current) setPrinted({ step: 'printed', pdf, url });
    })().catch(error => {
      if (!current) return;
      setPrinted({
        step: 'failed',
        problem:
          error instanceof ApiProblem
            ? error
            : new ApiProblem(0, {
                code: 'network_error',
                message: String(error),
              }),
      });
    });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return printed;
}

function Preview() {
  const summary = Route.useLoaderData();
  const base = `/api/templates/${encodeURIComponent(summary.id)}/versions/${summary.version}`;
  const printed = usePreview(`${base}/preview.pdf`);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link to="/templates" className="hover:underline">
              樣板
            </Link>{' '}
            /{' '}
            <Link
              to="/templates/$id"
              params={{ id: summary.id }}
              className="hover:underline">
              <code>{summary.id}</code>
            </Link>{' '}
            / v{summary.version}
          </p>
          <h1 className="text-2xl font-semibold">
            {summary.name} 第 {summary.version} 版預覽
          </h1>
          <p className="text-muted-foreground text-sm">
            用樣板包的範例資料填入後印出（A4{' '}
            {orientationLabel(summary.page.orientation)}）。
          </p>
        </div>
        <div className="flex gap-2">
          {printed.step === 'printed' ? (
            <a
              href={printed.url}
              download={`${summary.id}-v${summary.version}-preview.pdf`}
              className={buttonClass('outline')}>
              下載 PDF
            </a>
          ) : null}
          <a href={`${base}/pack.zip`} className={buttonClass('ghost')}>
            下載 zip
          </a>
        </div>
      </div>
      {printed.step === 'printing' ? (
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            正在列印範例…（可能要幾十秒）
          </CardContent>
        </Card>
      ) : null}
      {printed.step === 'failed' ? (
        <ProblemCard problem={printed.problem} />
      ) : null}
      {printed.step === 'printed' ? (
        <PdfPages
          pdf={printed.pdf}
          title={`${summary.name} 第 ${summary.version} 版預覽`}
        />
      ) : null}
    </div>
  );
}
