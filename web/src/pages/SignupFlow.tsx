import { useState, type FormEvent } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import { useAuth } from '../lib/auth';

/**
 * Signing up, one question at a time.
 *
 * It used to be one form of six fields with "Create workspace" at the bottom: a
 * business-type list with no option for a plumber, a currency dropdown, and no
 * word about VAT, which then decided every invoice silently. Now each step asks
 * one thing a person can answer without help, says what the answer changes, and
 * the account is made at the end, so nobody has a half-finished login lying
 * around because they closed the tab on step two.
 */

type Kind = 'trade' | 'agency' | 'consultant' | 'hosting' | 'ecommerce' | 'saas' | 'creator';

const KINDS: { key: Kind; label: string; line: string }[] = [
  { key: 'trade', label: 'Trade', line: 'Plumber, electrician, builder. Quotes, jobs and invoices. People you work for are called Customers.' },
  { key: 'agency', label: 'Agency or studio', line: 'Client projects, boards for the work, time you can bill.' },
  { key: 'consultant', label: 'Consultant or freelancer', line: 'A handful of clients and retainers, with very little admin.' },
  { key: 'hosting', label: 'Hosting or monthly services', line: 'Invoices that repeat and chase themselves.' },
  { key: 'ecommerce', label: 'Shop', line: 'Counter and online sales, stock and margins. No timesheets.' },
  { key: 'saas', label: 'Software', line: 'Subscriptions, releases and support.' },
  { key: 'creator', label: 'Content creator', line: 'A posting calendar, sponsors and briefs.' },
];

const CURRENCIES: [string, string][] = [
  ['ZAR', 'South African rand'], ['USD', 'US dollars'], ['EUR', 'Euros'], ['GBP', 'British pounds'],
  ['AUD', 'Australian dollars'], ['CAD', 'Canadian dollars'], ['NAD', 'Namibian dollars'],
  ['BWP', 'Botswana pula'], ['KES', 'Kenyan shillings'], ['NGN', 'Nigerian naira'],
];

const STEPS = 4;

export function SignupFlow({ onSignIn }: { onSignIn: () => void }) {
  const { signup } = useAuth();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<Kind | null>(null);
  const [business, setBusiness] = useState('');
  const [currency, setCurrency] = useState('ZAR');
  const [vat, setVat] = useState<boolean | null>(null);
  const [vatNumber, setVatNumber] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const word = kind === 'trade' || kind === 'ecommerce' ? 'customer' : 'client';
  const input = 'w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-3 text-base text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-quiet)]';
  const primary = 'w-full min-h-12 rounded-lg bg-[var(--accent)] text-sm font-semibold text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50';
  const choice = (on: boolean) => `w-full rounded-xl border p-4 text-left transition ${on
    ? 'border-[var(--accent)] bg-[var(--accent-quiet)]'
    : 'border-slate-700 bg-slate-900/40 hover:border-slate-500'}`;

  async function finish(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError('Your password needs at least 8 characters.'); return; }
    setBusy(true);
    try {
      await signup(business.trim(), name.trim(), email.trim(), password, {
        blueprint: kind ?? undefined, currency, vatRegistered: vat ?? undefined,
        vatNumber: vat ? vatNumber.trim() || undefined : undefined,
      });
      // Signed in: the app takes over and lands on Home.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          {step > 1 ? (
            <button onClick={() => { setStep(step - 1); setError(null); }} className="inline-flex min-h-9 items-center gap-1 text-slate-300 hover:text-slate-100">
              <ArrowLeft size={14} /> Back
            </button>
          ) : <span />}
          <span>Step {step} of {STEPS}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${(step / STEPS) * 100}%` }} />
        </div>
      </div>

      {step === 1 && (
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-100">What kind of work do you do?</h1>
          <p className="mt-1 text-sm text-slate-400">Klippy sets itself up to match. You can change any of it later.</p>
          <div className="mt-5 space-y-2">
            {KINDS.map((k) => (
              <button key={k.key} onClick={() => { setKind(k.key); setStep(2); }} className={choice(kind === k.key)}>
                <span className="block font-medium text-slate-100">{k.label}</span>
                <span className="mt-0.5 block text-sm text-slate-400">{k.line}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <form onSubmit={(e) => { e.preventDefault(); if (business.trim()) setStep(3); }}>
          <h1 className="font-display text-2xl font-bold text-slate-100">What is your business called?</h1>
          <p className="mt-1 text-sm text-slate-400">This is the name your {word}s see on every quote and invoice.</p>
          <input className={`${input} mt-5`} value={business} onChange={(e) => setBusiness(e.target.value)}
            placeholder={kind === 'trade' ? 'Mokoena Plumbing' : 'Your business name'} autoFocus required aria-label="Business name" />
          <label className="mt-4 block text-sm text-slate-300">
            What do you charge in?
            <select className={`${input} mt-1.5`} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
          </label>
          <p className="mt-1.5 text-xs text-slate-500">Klippy never converts money. If you bill someone in dollars, you type dollars and it stays dollars.</p>
          <button type="submit" disabled={!business.trim()} className={`${primary} mt-6`}>Next</button>
        </form>
      )}

      {step === 3 && (
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-100">Are you registered for VAT?</h1>
          <p className="mt-1 text-sm text-slate-400">This decides whether your invoices add VAT, and what they are called.</p>
          <div className="mt-5 space-y-2">
            <button onClick={() => { setVat(false); setStep(4); }} className={choice(vat === false)}>
              <span className="block font-medium text-slate-100">No, not yet</span>
              <span className="mt-0.5 block text-sm text-slate-400">
                Your invoices say Invoice and add no VAT. Most small businesses start here. In South Africa you only have to register once you pass R 1 million in sales in a year.
              </span>
            </button>
            <button onClick={() => setVat(true)} className={choice(vat === true)}>
              <span className="block font-medium text-slate-100">Yes, I am registered</span>
              <span className="mt-0.5 block text-sm text-slate-400">
                Your invoices say Tax invoice{currency === 'ZAR' ? ', add 15% VAT for you,' : ''} and show your VAT number.
              </span>
            </button>
          </div>
          {vat === true && (
            <form className="mt-4" onSubmit={(e) => { e.preventDefault(); setStep(4); }}>
              <label className="block text-sm text-slate-300">
                Your VAT number
                <input className={`${input} mt-1.5`} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)}
                  inputMode="numeric" placeholder="4123456789" autoFocus />
              </label>
              <p className="mt-1.5 text-xs text-slate-500">It prints on every tax invoice. Leave it blank if you do not have it handy and add it in Settings.</p>
              <button type="submit" className={`${primary} mt-5`}>Next</button>
            </form>
          )}
          <p className="mt-4 text-xs text-slate-500">Not sure? Pick No. You can change it in Settings in one tap, and only new invoices change.</p>
        </div>
      )}

      {step === 4 && (
        <form onSubmit={finish}>
          <h1 className="font-display text-2xl font-bold text-slate-100">Last step: your login</h1>
          <p className="mt-1 text-sm text-slate-400">No card needed. Nothing goes out to anybody until you press Send.</p>
          <div className="mt-5 space-y-3">
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
              autoComplete="name" required autoFocus aria-label="Your name" />
            <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourbusiness.co.za" autoComplete="email" required aria-label="Email" />
            <div className="relative">
              <input className={`${input} pr-16`} type={showPw ? 'text' : 'password'} value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="Pick a password, at least 8 characters"
                autoComplete="new-password" required aria-label="Password" />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-slate-400 hover:text-slate-200">
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-300">
            <div className="mb-1 text-xs font-medium text-slate-500">What you are setting up</div>
            <div className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              <span>{business || 'Your business'}, {KINDS.find((k) => k.key === kind)?.label.toLowerCase() ?? 'a business'}, charging in {CURRENCIES.find(([c]) => c === currency)?.[1]}.</span></div>
            <div className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              <span>{vat ? `VAT registered${vatNumber ? `, number ${vatNumber}` : ''}.` : 'Not registered for VAT.'}</span></div>
            <div className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              <span>A clean start: no example {word}s or made-up invoices to delete.</span></div>
          </div>

          {error && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
          <button type="submit" disabled={busy} className={`${primary} mt-5`}>{busy ? 'Setting it up' : 'Create my account'}</button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-slate-400">
        Already use Klippy? <button onClick={onSignIn} className="font-medium text-[var(--accent)]">Sign in</button>
      </p>
    </div>
  );
}
