/**
 * A failed request used to be indistinguishable from an empty one: views either sat
 * on "Loading..." forever or quietly rendered zeros, which reads as "the feature is
 * broken" with nothing to report. Anything that fetches should say so instead.
 */
export function ErrorNote({ error, onRetry, compact }: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  if (compact) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {message}
        {onRetry && (
          <button onClick={onRetry} className="ml-2 underline hover:text-red-200">Try again</button>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <p className="text-sm font-medium text-red-300">This could not load.</p>
      <p className="mt-1 text-xs text-red-300/80">{message}</p>
      {onRetry && (
        <button onClick={onRetry}
          className="mt-3 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10">
          Try again
        </button>
      )}
    </div>
  );
}
