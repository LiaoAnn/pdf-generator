import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ApiProblem } from '@/lib/api';
import { explainError } from '@/templates/explain';

/**
 * An API refusal in plain Traditional Chinese: one entry per issue with where
 * it is, and the raw code and message for whoever debugs the pack.
 */
export function ProblemCard({ problem }: { problem: ApiProblem }) {
  const { title, issues } = explainError(problem.error);
  return (
    <Card className="border-destructive/50" role="alert">
      <CardHeader>
        <CardTitle className="text-destructive">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {issues.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">
            {problem.error.code}: {problem.error.message}
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {issues.map((issue, i) => (
              // Issues have no identity beyond their order in the answer.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <li key={i} className="flex flex-col gap-1 border-l-2 pl-3">
                {issue.location ? (
                  <span className="text-sm font-medium">{issue.location}</span>
                ) : null}
                {/* A detail without a code adds to the issue before it. */}
                {issue.code === undefined && i > 0 ? (
                  <span className="text-muted-foreground text-sm">細節</span>
                ) : (
                  <span className="text-sm">{issue.explanation}</span>
                )}
                <code className="text-muted-foreground text-xs break-all">
                  {issue.raw}
                </code>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
