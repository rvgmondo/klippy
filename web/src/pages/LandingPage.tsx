import {
  LayoutGrid, CalendarDays, Timer, HardDrive, Receipt, Users,
  Palette, Bell, ArrowRight, Check,
} from 'lucide-react';

const FEATURES = [
  { icon: <LayoutGrid size={20} />, title: 'Boards for every client', body: 'Nestable folders, kanban boards, drag-and-drop cards, priorities, due dates and labels.' },
  { icon: <Timer size={20} />, title: 'Time that becomes money', body: 'Track time per card, then turn logged hours straight into an itemised invoice.' },
  { icon: <Receipt size={20} />, title: 'Quotes & invoices', body: 'Send branded quotes and invoices, take payments, and watch what is outstanding.' },
  { icon: <CalendarDays size={20} />, title: 'Calendar & reminders', body: 'Day, week, month and year views, plus a morning email of what is due.' },
  { icon: <HardDrive size={20} />, title: 'File storage', body: 'A document tree per workspace, so contracts and assets live next to the work.' },
  { icon: <Users size={20} />, title: 'Teams & workspaces', body: 'Invite people, group them into teams, and run multiple businesses from one login.' },
  { icon: <Palette size={20} />, title: 'Your brand', body: 'White-label the name and logo, pick your colours, light or dark. Make it yours.' },
  { icon: <Bell size={20} />, title: 'Install anywhere', body: 'Add it to your phone or desktop and get push notifications. Works offline.' },
];

export function LandingPage({ onGetStarted, onLogin }: { onGetStarted: () => void; onLogin: () => void }) {
  return (
    <div className="min-h-full bg-slate-950 text-slate-200">
      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white">K</div>
          <span className="text-lg font-semibold text-white">Klippy</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onLogin} className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:text-white">Log in</button>
          <button onClick={onGetStarted} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">Get started</button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(139,92,246,0.18),transparent)]" />
        <div className="mx-auto max-w-3xl px-5 py-20 text-center sm:py-28">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-xs text-slate-400">
            Run your whole business from one place
          </div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
            The work, the time, and the invoice.<br />
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">All in one tool.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-slate-400">
            Klippy brings your clients, tasks, time tracking, files and billing together, so tracked
            hours become invoices and nothing falls through the cracks.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <button onClick={onGetStarted} className="flex items-center gap-2 rounded-lg bg-violet-600 px-6 py-3 text-sm font-medium text-white hover:bg-violet-500">
              Start free <ArrowRight size={16} />
            </button>
            <button onClick={onLogin} className="rounded-lg border border-slate-700 px-6 py-3 text-sm text-slate-200 hover:bg-slate-900">
              I have an account
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-500">No credit card needed to start.</p>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-violet-600/15 text-violet-300">{f.icon}</div>
              <h3 className="mb-1 font-semibold text-white">{f.title}</h3>
              <p className="text-sm text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="mx-auto max-w-4xl px-5 py-16">
        <h2 className="mb-2 text-center text-2xl font-bold text-white">Simple pricing</h2>
        <p className="mb-10 text-center text-sm text-slate-400">Start free. Upgrade when your business grows.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PlanCard name="Free" price="R0" period="forever" cta="Start free" onClick={onGetStarted}
            features={['One workspace', 'Boards, calendar & time tracking', 'Up to 3 people', 'Invoices & quotes']} />
          <PlanCard name="Pro" price="R150" period="per month" highlight cta="Start free trial" onClick={onGetStarted}
            features={['Everything in Free', 'Unlimited workspaces & people', 'White-label branding', 'Priority support']} />
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">Prices shown as an example. Final pricing set at launch.</p>
      </section>

      <footer className="border-t border-slate-800 py-8 text-center text-xs text-slate-600">
        Klippy · built for people who run the whole show.
      </footer>
    </div>
  );
}

function PlanCard({ name, price, period, features, highlight, cta, onClick }: {
  name: string; price: string; period: string; features: string[]; highlight?: boolean; cta: string; onClick: () => void;
}) {
  return (
    <div className={`rounded-2xl border p-6 ${highlight ? 'border-violet-500 bg-violet-600/5' : 'border-slate-800 bg-slate-900/40'}`}>
      <div className="mb-1 text-sm font-medium text-slate-300">{name}</div>
      <div className="mb-4 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-white">{price}</span>
        <span className="text-sm text-slate-500">{period}</span>
      </div>
      <ul className="mb-6 space-y-2">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
            <Check size={16} className="mt-0.5 shrink-0 text-violet-400" /> {f}
          </li>
        ))}
      </ul>
      <button onClick={onClick} className={`w-full rounded-lg py-2.5 text-sm font-medium ${highlight ? 'bg-violet-600 text-white hover:bg-violet-500' : 'border border-slate-700 text-slate-200 hover:bg-slate-800'}`}>
        {cta}
      </button>
    </div>
  );
}
