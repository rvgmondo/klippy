import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';

/**
 * "Are you sure?", in the app's own clothes.
 *
 * window.confirm was doing this job in seventeen files. It works, but it is the
 * browser's dialog: unstyleable, differently worded and placed in every browser,
 * jarring in a white-labelled app a client may be looking at, and on some mobile
 * browsers it offers to suppress further dialogs, which would silently disable
 * every delete guard in the app.
 *
 * Deliberately NOT a hook with a provider. A promise-returning function keeps the
 * call sites reading the same as the ones it replaces, so converting twenty-two of
 * them was a mechanical change rather than a rewrite of twenty-two components.
 * `ConfirmHost` is mounted once, next to the app root.
 */

interface Request {
  message: string;
  confirmLabel?: string;
  /** Red button and stronger wording, for anything that destroys data. */
  danger?: boolean;
  /** Present for a prompt: the field's starting value and placeholder. */
  input?: { value: string; placeholder?: string; type?: 'text' | 'password' | 'number' };
}

type Pending = Request & { resolve: (v: boolean | string | null) => void };

let publish: ((p: Pending | null) => void) | null = null;

/**
 * Ask, and resolve to what they chose.
 *
 * Falls back to window.confirm when the host is not mounted, so a dialog is never
 * simply skipped: silently returning true would delete things nobody agreed to,
 * and silently returning false would make buttons look broken.
 */
export function confirmDialog(message: string, opts: Omit<Request, 'message' | 'input'> = {}): Promise<boolean> {
  if (!publish) return Promise.resolve(window.confirm(message));
  return new Promise<boolean>((resolve) => {
    publish!({ message, ...opts, resolve: (v) => resolve(v === true) });
  });
}

/**
 * Ask for a value. Resolves to the text, or null if they cancelled.
 *
 * Same shape as window.prompt so the thirteen call sites it replaces read the same,
 * but styled, escapable, and without the browser's offer to suppress future
 * dialogs. Blank is treated as cancel by most callers, so it is returned as-is and
 * left for them to decide.
 */
export function promptDialog(
  message: string,
  value = '',
  opts: { placeholder?: string; confirmLabel?: string; type?: 'text' | 'password' | 'number' } = {},
): Promise<string | null> {
  if (!publish) return Promise.resolve(window.prompt(message, value));
  return new Promise<string | null>((resolve) => {
    publish!({
      message,
      confirmLabel: opts.confirmLabel ?? 'Save',
      input: { value, placeholder: opts.placeholder, type: opts.type },
      resolve: (v) => resolve(typeof v === 'string' ? v : null),
    });
  });
}

/**
 * Say something, without blocking.
 *
 * The twelve window.alert calls this replaces were mostly "that failed" and
 * "that worked", and an alert is the wrong shape for both: it freezes the page and
 * demands a click for something the reader only needs to notice. A toast says it
 * and gets out of the way. Errors stay until dismissed, because an error you
 * blinked and missed is the same as no error at all.
 */
export function notify(message: string, tone: 'ok' | 'error' = 'ok'): void {
  if (!publishToast) { window.alert(message); return; }
  publishToast(message, tone);
}

interface Toast { id: number; message: string; tone: 'ok' | 'error' }
let publishToast: ((m: string, t: 'ok' | 'error') => void) | null = null;
let toastId = 0;

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    publish = (p) => { setText(p?.input?.value ?? ''); setPending(p); };
    publishToast = (message, tone) => {
      const id = ++toastId;
      setToasts((t) => [...t, { id, message, tone }]);
      // Successes fade; errors wait to be dismissed.
      if (tone === 'ok') window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    };
    return () => { publish = null; publishToast = null; };
  }, []);

  const toastStack = toasts.length ? createPortal(
    <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 left-1/2 z-[200] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : undefined}
          className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${
            t.tone === 'error'
              ? 'border-red-500/40 bg-red-950 text-red-100'
              : 'border-slate-700 bg-slate-900 text-slate-100'}`}>
          <span className="flex-1">{t.message}</span>
          <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            className="shrink-0 text-slate-400 hover:text-slate-200">Dismiss</button>
        </div>
      ))}
    </div>,
    document.body,
  ) : null;

  if (!pending) return toastStack;

  const done = (v: boolean | string | null) => {
    pending.resolve(v);
    setPending(null);
  };

  const dialog = (
    <Modal onClose={() => done(pending.input ? null : false)} size="sm" labelledBy="confirm-message">
      <form className="p-5" onSubmit={(e) => { e.preventDefault(); done(pending.input ? text : true); }}>
        <p id="confirm-message" className="whitespace-pre-line text-sm text-slate-100">{pending.message}</p>

        {pending.input && (
          <input
            autoFocus
            type={pending.input.type ?? 'text'}
            value={text}
            placeholder={pending.input.placeholder}
            onChange={(e) => setText(e.target.value)}
            className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]"
          />
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => done(pending.input ? null : false)}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
          <button type="submit" autoFocus={!pending.input}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              pending.danger
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'bg-[var(--accent)] text-[var(--accent-ink)] hover:opacity-90'}`}>
            {pending.confirmLabel ?? (pending.danger ? 'Delete' : 'Confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );

  return <>{dialog}{toastStack}</>;
}
