import {
  type TemplateSummary,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ProblemCard } from '@/components/problem-card';
import { Button, buttonClass } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ApiProblem, api } from '@/lib/api';

export const Route = createFileRoute('/templates/upload')({
  ssr: false,
  component: Upload,
});

type State =
  | { step: 'idle' }
  | { step: 'sending' }
  | { step: 'stored'; summary: TemplateSummary }
  | { step: 'refused'; problem: ApiProblem };

function Upload() {
  const [file, setFile] = useState<File>();
  const [state, setState] = useState<State>({ step: 'idle' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setState({ step: 'sending' });
    try {
      const summary = await api('/api/templates', templateSummarySchema, {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: file,
      });
      setState({ step: 'stored', summary });
    } catch (error) {
      setState({
        step: 'refused',
        problem:
          error instanceof ApiProblem
            ? error
            : new ApiProblem(0, {
                code: 'network_error',
                message: String(error),
              }),
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">上傳樣板包</h1>
        <p className="text-muted-foreground text-sm">
          把樣板包資料夾的內容壓成 zip（manifest.json
          要在最上層）。平台會先檢查，通過才會存成新版本；網頁上不能編輯 HTML。
        </p>
      </div>
      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-wrap items-center gap-4">
            <input
              type="file"
              name="pack"
              accept=".zip,application/zip"
              aria-label="樣板包 zip"
              onChange={event => {
                setFile(event.target.files?.[0]);
                setState({ step: 'idle' });
              }}
              className="text-sm file:mr-4 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
            />
            <Button type="submit" disabled={!file || state.step === 'sending'}>
              {state.step === 'sending' ? '檢查中…' : '上傳並檢查'}
            </Button>
          </form>
        </CardContent>
      </Card>
      {state.step === 'stored' ? <Stored summary={state.summary} /> : null}
      {state.step === 'refused' ? (
        <ProblemCard problem={state.problem} />
      ) : null}
    </div>
  );
}

function Stored({ summary }: { summary: TemplateSummary }) {
  return (
    <Card className="border-green-600/40">
      <CardHeader>
        <CardTitle>
          已存成 {summary.name} 第 {summary.version} 版
        </CardTitle>
        <CardDescription>
          樣板包通過檢查。樣板 ID <code>{summary.id}</code>
          {summary.version > 1 ? '，舊版本都還在。' : '。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-3">
        <Link
          to="/templates/$id/$version"
          params={{ id: summary.id, version: String(summary.version) }}
          className={buttonClass()}>
          看預覽
        </Link>
        <Link
          to="/templates/$id"
          params={{ id: summary.id }}
          className={buttonClass('outline')}>
          所有版本
        </Link>
      </CardContent>
    </Card>
  );
}
