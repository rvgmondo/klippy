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
 *
 * Four shapes, because the app genuinely has four:
 *   center  Modal supplies the card. New dialogs should use this.
 *   panel   the child supplies its own box, vertically centred. For dialogs that
 *           need their own height or scroll behaviour.
 *   page    the child supplies its own box, top-aligned and scrolling. The
 *           printable invoice and statement, which are white pages not dark cards.
 *   drawer  a full-height panel down the right. Card detail.
 */
export type ModalVariant = 'center' | 'panel' | 'page' | 'drawer';

export function Modal({
  children, onClose, size = 'md', variant = 'center', confirmClose, labelledBy,
}: {
  children: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: ModalVariant;
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

  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];

  /**
   * Closing is decided by WHICH element was pressed, not by children stopping the
   * event. The child is a direct descendant of the backdrop, so a press on it never
   * has the backdrop as its target and the old stopPropagation calls become dead
   * weight. It is also mousedown rather than click, so dragging to select text and
   * releasing past the edge of the dialog no longer counts as clicking away.
   */
  const backdrop = (extra: string) => ({
    className: `fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm ${extra}`,
    onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) attempt(); },
    role: 'dialog' as const,
    'aria-modal': true,
    'aria-labelledby': labelledBy,
  });

  const node = variant === 'drawer' ? (
    <div {...backdrop('flex justify-end')}>
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-800 bg-slate-950 shadow-2xl">
        {children}
      </div>
    </div>
  ) : variant === 'page' ? (
    <div {...backdrop('overflow-y-auto p-4')}>{children}</div>
  ) : variant === 'panel' ? (
    <div {...backdrop('grid place-items-center p-4')}>{children}</div>
  ) : (
    <div {...backdrop('flex justify-center overflow-y-auto p-4')}>
      <div className={`my-auto w-full ${width} rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl`}>
        {children}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
