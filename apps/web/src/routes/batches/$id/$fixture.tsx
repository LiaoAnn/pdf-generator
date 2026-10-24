import { type BlockType, gtSchema } from '@pdf-generator/contract';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { typeColor, typeCounts } from '@/batches/overlay';
import { GtBlockList } from '@/components/gt-block-list';
import { GtBoxes } from '@/components/gt-boxes';
import { PdfPages } from '@/components/pdf-pages';
import { ProblemCard } from '@/components/problem-card';
import { buttonClass } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiProblem, api, problem } from '@/lib/api';

const fixtureBase = (id: string, fixture: string) =>
  `/api/batches/${encodeURIComponent(id)}/fixtures/${encodeURIComponent(fixture)}`;

export const Route = createFileRoute('/batches/$id/$fixture')({
  ssr: false,
  loader: async ({ params }) => {
    const base = fixtureBase(params.id, params.fixture);
    const [gt, pdf] = await Promise.all([
      api(`${base}/gt.json`, gtSchema),
      fetch(`${base}/fixture.pdf`, { credentials: 'same-origin' }).then(
        async response => {
          if (!response.ok) throw await problem(response);
          return response.arrayBuffer();
        },
      ),
    ]);
    return { gt, pdf };
  },
  component: FixturePage,
  errorComponent: ({ error }) =>
    error instanceof ApiProblem ? (
      <ProblemCard problem={error} />
    ) : (
      <p>{String(error)}</p>
    ),
});

const downloads = [
  { file: 'fixture.pdf', label: '下載 PDF' },
  { file: 'gt.json', label: '下載 gt.json' },
  { file: 'data.json', label: '下載 data.json' },
] as const;

function FixturePage() {
  const { id, fixture } = Route.useParams();
  const { gt, pdf } = Route.useLoaderData();
  const [hidden, setHidden] = useState<ReadonlySet<BlockType>>(new Set());
  // The selected block, and which side was clicked: the other side scrolls.
  const [selected, setSelected] = useState<{
    id: string;
    from: 'box' | 'list';
  }>();
  const pages = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const base = fixtureBase(id, fixture);
  const name = fixture.padStart(4, '0');

  const toggle = (type: BlockType) =>
    setHidden(previous => {
      const next = new Set(previous);
      if (!next.delete(type)) next.add(type);
      return next;
    });

  useEffect(() => {
    if (!selected) return;
    const id = CSS.escape(selected.id);
    if (selected.from === 'box') {
      list.current
        ?.querySelector(`[data-block-row="${id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    } else {
      pages.current
        ?.querySelector(`[data-block-id="${id}"]`)
        ?.scrollIntoView({ block: 'center' });
    }
  }, [selected]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link to="/batches" className="hover:underline">
              批次
            </Link>{' '}
            /{' '}
            <Link to="/batches/$id" params={{ id }} className="hover:underline">
              <code>{id.slice(0, 8)}</code>
            </Link>{' '}
            / {name}
          </p>
          <h1 className="text-2xl font-semibold">
            {gt.source.templateId} v{gt.source.templateVersion} 第 {name} 份
          </h1>
          <p className="text-muted-foreground text-sm">
            {gt.pages.length} 頁 · {gt.blocks.length} 個區塊
          </p>
        </div>
        <div className="flex gap-2">
          {downloads.map(({ file, label }) => (
            <a
              key={file}
              href={`${base}/${file}`}
              className={buttonClass('outline')}>
              {label}
            </a>
          ))}
        </div>
      </div>
      <Card>
        <CardContent>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <legend className="sr-only">顯示的區塊類型</legend>
            {typeCounts(gt.blocks).map(({ type, count }) => (
              <label key={type} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!hidden.has(type)}
                  onChange={() => toggle(type)}
                />
                <span
                  aria-hidden
                  className="inline-block size-3 rounded-sm"
                  style={{ backgroundColor: typeColor(type) }}
                />
                {type}（{count}）
              </label>
            ))}
          </fieldset>
        </CardContent>
      </Card>
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_18rem]">
        <div ref={pages}>
          <PdfPages
            pdf={pdf}
            title={`第 ${name} 份`}
            overlay={page => {
              const size = gt.pages[page - 1];
              return size ? (
                <GtBoxes
                  blocks={gt.blocks}
                  page={page}
                  size={size}
                  hidden={hidden}
                  selectedId={selected?.id}
                  onSelect={id => setSelected({ id, from: 'box' })}
                />
              ) : null;
            }}
          />
        </div>
        <Card className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto py-2">
          <div ref={list}>
            <GtBlockList
              blocks={gt.blocks}
              hidden={hidden}
              selectedId={selected?.id}
              onSelect={id => setSelected({ id, from: 'list' })}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
