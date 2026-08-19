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
  // The database's own message, when there is one. It is the line that actually
  // says what is wrong, so it belongs on screen rather than only in a server log.
  const cause = (error as { cause?: unknown })?.cause;
  const causeText = typeof cause === 'string' ? cause : null;
  if (compact) {
    return (
      <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {message}
        {onRetry && (
          <button onClick={onRetry} className="ml-2 underline hover:text-red-200">Try again</button>
        )}
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <p className="text-sm font-medium text-red-300">This could not load.</p>
      <p className="mt-1 text-xs text-red-300/80">{message}</p>
      {causeText && (
        <p className="num mt-2 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-200">{causeText}</p>
      )}
      {onRetry && (
        <button onClick={onRetry}
          className="mt-3 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10">
          Try again
        </button>
      )}
    </div>
  );
}
