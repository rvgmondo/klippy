import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A dialog that always covers the whole app.
 *
 * Rendered through a portal into document.body rather than where it is written,
 * because `position: fixed` does NOT resolve against the viewport when any ancestor
 * has a transform. The sidebar rows are drag-sortable and carry one, so a modal
 * opened from a folder was being laid out inside that row: a full-screen dialog
 * squeezed into a 200px strip. Portalling is the fix that holds regardless of what
 * an ancestor does later.
 *
 * `onClose` is only called for a deliberate close. Clicking the backdrop is
 * deliberate for a small dialog and a disaster for a half-typed invoice, so
 * `confirmClose` lets a form say "ask me first" and nothing is thrown away by a
 * stray click.
 */
export function Modal({ children, onClose, size = 'md', confirmClose, labelledBy }: {
  children: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Return true to allow closing. Called for backdrop clicks and Escape. */
  confirmClose?: () => boolean;
  labelledBy?: string;
}) {
  const attempt = () => {
    if (confirmClose && !confirmClose()) return;
    onClose();
  };

  // Escape closes, and the page behind does not scroll while a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') attempt(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  });

  const width = {
    sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl',
  }[size];

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) attempt(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      {/* mousedown rather than click on the backdrop: a click that STARTS inside the
          dialog and finishes outside (dragging to select text, releasing past the
          edge) would otherwise register as "clicked outside" and close it. */}
      <div
        className={`my-auto w-full ${width} rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
