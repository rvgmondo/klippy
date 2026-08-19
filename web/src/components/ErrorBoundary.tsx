import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Stops one bad render from white-screening the whole app.
 *
 * Without this, any error thrown while rendering (a malformed payload, an undefined
 * a component did not guard) unmounts the entire tree and the user is left staring
 * at a blank page with no way forward but a manual reload they have to think of. For
 * staff that is annoying; for the client portal it is a supplier's software visibly
 * breaking in front of their customer. This catches it, shows a plain recovery card,
 * and keeps the rest of the app alive.
 *
 * A class component on purpose: React only exposes error boundaries this way.
 */
interface Props { children: ReactNode; portal?: boolean }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('render error caught by boundary:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const portal = this.props.portal;
    return (
      <div style={{
        minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px',
        fontFamily: 'system-ui, sans-serif',
        background: portal ? '#f8fafc' : 'var(--app-bg, #0e1013)',
        color: portal ? '#0f172a' : 'var(--app-fg, #e7e9ee)',
      }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong on this screen</h1>
          <p style={{ opacity: 0.7, fontSize: 14, marginBottom: 20 }}>
            The rest of the app is fine. Reloading usually clears it.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              borderRadius: 10, padding: '10px 18px', fontSize: 14, fontWeight: 600,
              border: 'none', cursor: 'pointer',
              background: portal ? '#0f172a' : 'var(--accent, #6366f1)',
              color: portal ? '#fff' : 'var(--accent-ink, #fff)',
            }}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
