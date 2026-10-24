import { explainFixtureError } from '../templates/explain';

/** A failed fixture's error as stored, explained below when it is known. */
export function FixtureError({ error }: { error: string }) {
  const explanation = explainFixtureError(error);
  return (
    <>
      <span className="text-destructive">{error}</span>
      {explanation ? (
        <span className="text-muted-foreground block">{explanation}</span>
      ) : null}
    </>
  );
}
