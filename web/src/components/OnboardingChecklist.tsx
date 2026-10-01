import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, ChevronRight, X } from 'lucide-react';
import { apiGet } from '../lib/api';
import { setUrlParams } from '../lib/urlAction';
import { useAuth } from '../lib/auth';

interface Step {
  key: string; done: boolean;
  note?: 'sandbox';
  /** Which business is in test mode, and whether the gateway is its own. */
  noteLabel?: string | null;
  noteScope?: 'own' | 'workspace' | null;
}

/**
 * The first-run checklist.
 *
 * A new workspace used to land on an empty dashboard with no "do these things
 * first", and every screen it pointed at was also empty. This card names the six
 * moves that make Klippy start working for you, ticks itself as each one
 * happens, and takes you straight to the right screen with the right form
 * already opening. It leaves on its own when everything is done, and can be
 * hidden by hand before that.
 */
type Nav = (view: string) => void;
const META: Record<string, { label: (w: Words) => string; hint: (w: Words) => string; go: (nav: Nav) => void }> = {
  client: {
    label: (w) => `Add your first ${w.one}`,
    hint: () => 'A name and a cell number is enough to send them a quote.',
    // The sidebar is mounted and listening; the form opens right here on Home.
    go: () => setUrlParams({ 'new-client': '1' }),
  },
  invoice: {
    label: () => 'Send your first quote or invoice',
    hint: () => 'Once it goes out, Klippy keeps track of it and reminds them if they are late.',
    go: (nav) => { setUrlParams({ new: 'quote' }); nav('billing'); },
  },
  bank: {
    label: () => 'Add your bank details',
    hint: () => 'So every invoice tells them where to pay you by EFT.',
    go: (nav) => { setUrlParams({ s: 'biz:invoicing' }); nav('settings'); },
  },
  brand: {
    label: () => 'Add your logo and colour',
    hint: (w) => `It goes on every quote, invoice and email your ${w.many} see.`,
    go: (nav) => { setUrlParams({ s: 'biz:brand' }); nav('settings'); },
  },
  offering: {
    label: () => 'Write down your prices',
    hint: () => 'Then a quote is a few taps: pick the item, the price fills itself in.',
    go: (nav) => { setUrlParams({ new: '1' }); nav('offerings'); },
  },
  deal: {
    label: () => 'Add a job you are trying to win',
    hint: () => 'So the follow-up lands on your Home on the right day.',
    go: (nav) => { setUrlParams({ new: '1' }); nav('pipeline'); },
  },
  payments: {
    label: (w) => `Let ${w.many} pay by card (optional)`,
    hint: () => 'A Pay now button on every invoice, and it marks itself paid. Your payment provider charges a small fee.',
    go: (nav) => { setUrlParams({ s: 'payments' }); nav('settings'); },
  },
};

interface Words { one: string; many: string }

export function OnboardingChecklist({ onNavigate }: { onNavigate?: (view: string) => void } = {}) {
  const { account } = useAuth();
  const words: Words = {
    one: (account?.folderLabelSingular || 'Client').toLowerCase(),
    many: (account?.folderLabelPlural || 'Clients').toLowerCase(),
  };
  const [hidden, setHidden] = useState(() => localStorage.getItem('klippy.onboarding.hidden') === '1');
  const { data } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => apiGet<{ steps: Step[] }>('/onboarding'),
    staleTime: 60_000,
    enabled: !hidden,
  });
  if (hidden || !data) return null;
  const steps = data.steps.filter((s) => META[s.key]);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  const hide = () => { localStorage.setItem('klippy.onboarding.hidden', '1'); setHidden(true); };

  return (
    <section className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-quiet)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Getting set up</h2>
          <p className="text-[11px] text-slate-400">{done} of {steps.length} done. Each one takes a minute or two, and none of them is required to start.</p>
        </div>
        <button onClick={hide} title="Hide this checklist" aria-label="Hide the setup checklist"
          className="tap text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X size={14} /></button>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {steps.map((s) => {
          const m = META[s.key]!;
          return s.done ? (
            <div key={s.key} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 opacity-60">
              <CheckCircle2 size={16} className="shrink-0 text-[var(--accent)]" />
              <span className="text-sm text-slate-400 line-through decoration-slate-600">{m.label(words)}</span>
            </div>
          ) : (
            <button key={s.key} onClick={() => m.go(onNavigate ?? (() => {}))}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800/50">
              <Circle size={16} className="shrink-0 text-slate-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-200">{m.label(words)}</span>
                {s.note === 'sandbox' ? (
                  // The usual hint says to switch payments on, which is wrong for someone
                  // whose gateway is already on in test mode.
                  <span className="block text-[11px] text-amber-300">
                    PayFast is on in test mode{s.noteLabel ? ` for ${s.noteLabel}` : ''}, so clients cannot pay real money
                    yet. Switch Sandbox off {s.noteScope === 'own' ? "under that business's own Payments" : 'under Settings, Payments'} once a
                    test payment has worked.
                  </span>
                ) : (
                  <span className="block text-[11px] text-slate-500">{m.hint(words)}</span>
                )}
              </span>
              <ChevronRight size={14} className="shrink-0 text-slate-600 group-hover:text-slate-300" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
