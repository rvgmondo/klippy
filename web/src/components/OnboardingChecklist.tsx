import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, ChevronRight, X } from 'lucide-react';
import { apiGet } from '../lib/api';
import { setUrlParams } from '../lib/urlAction';

interface Step { key: string; done: boolean }

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
const META: Record<string, { label: string; hint: string; go: (nav: Nav) => void }> = {
  client: {
    label: 'Add your first client',
    hint: 'Everything hangs off a client: boards, time, invoices, their portal.',
    // The sidebar is mounted and listening; the modal opens right here on Home.
    go: () => setUrlParams({ 'new-client': '1' }),
  },
  brand: {
    label: 'Put your brand on it',
    hint: 'Your name and colour on every invoice, email and portal page.',
    go: (nav) => { setUrlParams({ s: 'biz:brand' }); nav('settings'); },
  },
  offering: {
    label: 'Write down what you sell',
    hint: 'Offerings price your invoices and power subscriptions.',
    go: (nav) => { setUrlParams({ new: '1' }); nav('offerings'); },
  },
  deal: {
    label: 'Track your first deal',
    hint: 'Or share your lead form and let leads add themselves.',
    go: (nav) => { setUrlParams({ new: '1' }); nav('pipeline'); },
  },
  invoice: {
    label: 'Send your first invoice',
    hint: 'From scratch or straight out of tracked time.',
    go: (nav) => { setUrlParams({ new: 'invoice' }); nav('billing'); },
  },
  payments: {
    label: 'Switch on online payments',
    hint: 'A pay link on every invoice gets you paid days sooner.',
    go: (nav) => { setUrlParams({ s: 'payments' }); nav('settings'); },
  },
};

export function OnboardingChecklist({ onNavigate }: { onNavigate?: (view: string) => void } = {}) {
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
          <p className="text-[11px] text-slate-400">{done} of {steps.length} done. Each one takes a minute or two.</p>
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
              <span className="text-sm text-slate-400 line-through decoration-slate-600">{m.label}</span>
            </div>
          ) : (
            <button key={s.key} onClick={() => m.go(onNavigate ?? (() => {}))}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800/50">
              <Circle size={16} className="shrink-0 text-slate-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-200">{m.label}</span>
                <span className="block text-[11px] text-slate-500">{m.hint}</span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-slate-600 group-hover:text-slate-300" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
