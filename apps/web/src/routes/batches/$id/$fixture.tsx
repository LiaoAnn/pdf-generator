import { createFileRoute, Link } from '@tanstack/react-router';
import { buttonClass } from '@/components/ui/button';

export const Route = createFileRoute('/batches/$id/$fixture')({
  ssr: false,
  component: FixturePage,
});

const downloads = [
  { file: 'fixture.pdf', label: '下載 PDF' },
  { file: 'gt.json', label: '下載 gt.json' },
  { file: 'data.json', label: '下載 data.json' },
] as const;

function FixturePage() {
  const { id, fixture: index } = Route.useParams();
  const base = `/api/batches/${encodeURIComponent(id)}/fixtures/${encodeURIComponent(index)}`;
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
            / {index.padStart(4, '0')}
          </p>
          <h1 className="text-2xl font-semibold">第 {index} 份</h1>
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
    </div>
  );
}
