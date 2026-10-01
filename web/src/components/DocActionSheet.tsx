import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Mail, Check, X } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { Modal } from './Modal';
import { notify } from './ConfirmDialog';
import { btnPrimary, btnSecondary } from './ui';
import { money } from '../lib/money';

/**
 * Send, Chase and Remind, finished where you are standing.
 *
 * Each of these used to be a trip: Home said something was late, Collections had
 * the button, Billing had the WhatsApp link. This one sheet is used by Home, the
 * client page and Money, so the same verb does the same thing everywhere.
 *
 * WhatsApp opens on your own phone with the message written, including the pay
 * link. The tab is opened BEFORE the link is fetched, because a browser blocks a
 * window opened after a wait as a pop-up.
 */
export type DocAction = 'send' | 'chase' | 'remind';

export interface DocRef {
  id: number;
  number: string;
  clientName?: string | null;
  amount?: number;
  currency?: string;
  type?: string;
}

/** Everything that shows money or a to-do list re-reads after one of these. */
export function useMoneyRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['documents', 'document', 'collections', 'home', 'client', 'clients', 'payments', 'cashflow']) {
      qc.invalidateQueries({ queryKey: [k] });
    }
  };
}

export function DocActionSheet({ doc, action, onClose }: { doc: DocRef; action: DocAction; onClose: () => void }) {
  const refresh = useMoneyRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  const kind = doc.type === 'quote' ? 'quote' : 'invoice';

  const title = action === 'send' ? `Send ${doc.number}`
    : action === 'chase' ? `Chase ${doc.clientName ?? doc.number}`
      : `Remind them about ${doc.number}`;
  const lead = action === 'send'
    ? `Pick how it goes. All three mark it sent, so Klippy starts counting it as owed${kind === 'quote' ? ' once they say yes' : ''}.`
    : action === 'chase'
      ? 'A friendly reminder with what is owed and how to pay. WhatsApp gets read; email carries their statement.'
      : 'A short nudge with the link to look at it again.';

  async function viaWhatsApp() {
    const tab = window.open('', '_blank');
    setBusy('wa');
    try {
      const r = await apiGet<{ url: string }>(`/documents/${doc.id}/whatsapp-link`);
      if (tab) tab.location.href = r.url; else window.open(r.url, '_blank', 'noopener');
      if (action === 'send') await apiPatch(`/documents/${doc.id}/status`, { status: 'sent' });
      refresh();
      notify(action === 'send' ? `${doc.number} is sent. Finish it in WhatsApp.` : 'WhatsApp is open with the message written.');
      onClose();
    } catch (e) {
      tab?.close();
      notify(e instanceof Error ? e.message : 'Could not build the WhatsApp message.', 'error');
    } finally { setBusy(null); }
  }

  async function viaEmail() {
    setBusy('email');
    try {
      if (action === 'chase') {
        const r = await apiPost<{ sent: number; skipped?: unknown[] }>('/collections/chase', { ids: [doc.id] });
        if (!r.sent) throw new Error('No email went out. Check they have an email address on their client record.');
        notify(`Chased by email, with their statement. ${doc.number} is marked as chased today.`);
      } else {
        await apiPost(`/documents/${doc.id}/email`, {});
        notify(action === 'send' ? `${doc.number} is emailed and marked sent.` : `${doc.number} emailed to them again.`);
      }
      refresh();
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'The email did not go out.', 'error');
    } finally { setBusy(null); }
  }

  async function sentMyself() {
    setBusy('self');
    try {
      await apiPatch(`/documents/${doc.id}/status`, { status: 'sent' });
      refresh();
      notify(`${doc.number} is marked sent. Klippy will chase it like any other.`);
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'That did not go through.', 'error');
    } finally { setBusy(null); }
  }

  return (
    <Modal onClose={onClose} size="sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold text-slate-100">{title}</h2>
          {doc.amount != null && doc.currency && (
            <p className="num mt-0.5 text-sm text-slate-400">
              {doc.clientName ? `${doc.clientName}, ` : ''}{money(doc.amount, doc.currency)}
            </p>
          )}
        </div>
        <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
      </div>
      <p className="mt-3 text-sm text-slate-300">{lead}</p>
      <div className="mt-4 grid gap-2">
        <button disabled={!!busy} onClick={viaWhatsApp}
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          <MessageCircle size={16} /> {busy === 'wa' ? 'Opening WhatsApp' : 'WhatsApp it'}
        </button>
        <button disabled={!!busy} onClick={viaEmail} className={`${action === 'send' ? btnSecondary : btnPrimary} flex min-h-11 items-center justify-center gap-2`}>
          <Mail size={16} /> {busy === 'email' ? 'Sending' : action === 'chase' ? 'Email it, with their statement' : 'Email it'}
        </button>
        {action === 'send' && (
          <button disabled={!!busy} onClick={sentMyself} className={`${btnSecondary} flex min-h-11 items-center justify-center gap-2`}>
            <Check size={16} /> I sent it myself
          </button>
        )}
      </div>
    </Modal>
  );
}
