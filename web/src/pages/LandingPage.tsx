import { Suspense, lazy, useEffect, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { hasWebGL, useReducedMotion } from '../marketing/motion';
import { useMarketingMotion } from '../marketing/useMarketingMotion';
import '../marketing/marketing.css';

/**
 * The public page for Klippy.
 *
 * Art direction: exaggerated minimalism in the product's own Midnight Signal
 * identity. The claim being sold is reductive ("one place instead of six"), so
 * the page argues it by being spare: an enormous type scale, a great deal of
 * empty space, one accent, and no decoration that is not carrying meaning. The
 * previous version was a violet-gradient SaaS template that shared no colour,
 * typeface or idea with the product behind the login.
 *
 * Everything expensive is behind a condition. The WebGL field loads only when
 * the device can run it and the visitor has not asked for less motion; the
 * scroll libraries load on the same terms. This module is itself a lazy chunk,
 * so a signed-in founder opening their dashboard never downloads a byte of it.
 */
const SignalField = lazy(() => import('../marketing/SignalField'));

const AREAS = [
  { key: 'Home', line: 'What needs you today, and what the business is worth, on one screen.' },
  { key: 'Work', line: 'Boards per client, a timer on every card, and a day you can actually plan.' },
  { key: 'Sales', line: 'Leads arrive on their own, quotes get accepted online, deals move.' },
  { key: 'Money', line: 'Invoices, what is owed, what is coming in, and who to chase first.' },
  { key: 'Admin', line: 'Your brand, your people, your files, your backups. Set once.' },
];

const SCATTER = ['A board', 'A timer', 'A spreadsheet', 'An invoice', 'A reminder', 'Your memory'];

const AUTOMATIC = [
  ['Chases what is owed', 'Overdue invoices get chased on your schedule, by email and WhatsApp, with a pay link and their statement attached.'],
  ['Bills the recurring work', 'Subscriptions raise their own invoices on the right day, whether that is monthly, quarterly or yearly.'],
  ['Catches the leads', 'Your lead form drops enquiries straight into the pipeline and tells you the moment one lands.'],
  ['Backs itself up', 'Your whole workspace exported and emailed to you every Sunday, so the worst case is a week old.'],
];

export function LandingPage({ onGetStarted, onLogin }: { onGetStarted: () => void; onLogin: () => void }) {
  const reduced = useReducedMotion();
  const [canRender3d, setCanRender3d] = useState(false);
  useMarketingMotion();

  /**
   * Who actually gets the WebGL field.
   *
   * Three.js is 522kB of JavaScript, and on a throttled phone CPU parsing it
   * cost 490ms of blocked main thread and dragged the mobile Lighthouse score to
   * 72. For a decorative hero that is not a trade worth making, and on South
   * African mobile data it is somebody's airtime. So the field is for wide
   * screens with a few cores to spare; everyone else gets the static version,
   * which was built for the no-WebGL case and looks deliberate rather than
   * degraded.
   *
   * Even then it waits for an idle moment, so it can never compete with the
   * largest paint. requestIdleCallback is missing on Safari, hence the timeout.
   */
  useEffect(() => {
    if (reduced) { setCanRender3d(false); return; }
    const wideEnough = window.innerWidth >= 1024;
    const enoughCores = (navigator.hardwareConcurrency ?? 4) >= 4;
    if (!wideEnough || !enoughCores || !hasWebGL()) { setCanRender3d(false); return; }

    const idle = (cb: () => void) => (
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(cb, { timeout: 2500 })
        : window.setTimeout(cb, 1200)
    );
    const cancel = (h: number) => (
      typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback(h) : clearTimeout(h)
    );
    const handle = idle(() => setCanRender3d(true)) as number;
    return () => cancel(handle);
  }, [reduced]);

  // Reveals begin hidden only when the scripted layer will actually run them.
  useEffect(() => {
    if (!reduced) document.documentElement.classList.add('mk-js');
    return () => document.documentElement.classList.remove('mk-js');
  }, [reduced]);

  return (
    <div className="mk min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[var(--mk-accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--mk-ink)]">
        Skip to content
      </a>

      <header className="relative z-20 mx-auto flex max-w-[1400px] items-center justify-between px-5 py-5 pt-safe sm:px-10">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--mk-accent)] text-sm font-bold text-[var(--mk-ink)]">K</div>
          <span className="text-lg font-semibold">Klippy</span>
        </div>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a href="#how" className="hidden rounded-lg px-3 py-2 text-sm mk-muted hover:text-[var(--mk-fg)] sm:inline-block">How it works</a>
          <a href="#pricing" className="hidden rounded-lg px-3 py-2 text-sm mk-muted hover:text-[var(--mk-fg)] sm:inline-block">Pricing</a>
          <button onClick={onLogin} className="rounded-lg px-3 py-2 text-sm mk-muted hover:text-[var(--mk-fg)]">Log in</button>
          <button onClick={onGetStarted} className="mk-cta rounded-lg px-4 py-2 text-sm">Start free</button>
        </nav>
      </header>

      <main id="main">
        {/* ---- Hero ------------------------------------------------------ */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0">
            {canRender3d ? (
              <Suspense fallback={null}>
                <SignalField accent="#c9f24e" />
              </Suspense>
            ) : (
              /* The static stand-in for no WebGL and for reduced motion: the same
                 idea (a signal in the dark) with nothing running. */
              <div className="absolute inset-0 bg-[radial-gradient(58%_45%_at_50%_8%,rgba(201,242,78,0.10),transparent_70%)]" />
            )}
          </div>

          <div className="relative mx-auto max-w-[1400px] px-5 pb-20 pt-16 sm:px-10 sm:pb-32 sm:pt-24">
            <p className="mk-eyebrow mk-accent mb-6">For people who run the whole thing themselves</p>
            {/* No ch-based cap here. `ch` is measured from the font, so the
                swap from the fallback to Bricolage re-measured it, re-wrapped
                the headline onto an extra line and pushed the whole page down
                41px: 0.033 of layout shift on a phone. The break is explicit
                anyway, so the cap was doing nothing but inviting the reflow. */}
            <h1 className="mk-display">
              The work, the time,<br />the invoice.
            </h1>
            <p className="mk-display mk-accent mt-1">One place.</p>

            <p className="mk-lead mk-muted mt-8 max-w-[34rem]">
              Klippy is the operating system for a business you run yourself. Track the work, run the
              timer on it, and turn those hours into an invoice that chases itself while you get on
              with the next thing.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <button onClick={onGetStarted} className="mk-cta flex items-center gap-2 rounded-xl px-7 py-4 text-base">
                Start free <ArrowRight size={17} />
              </button>
              <a href="#how" className="rounded-xl border mk-rule px-7 py-4 text-base hover:bg-white/5">
                See how it works
              </a>
            </div>
            <p className="mk-muted mt-4 text-sm">
              No card to start. Your data exports to a file whenever you want it.
            </p>
          </div>
        </section>

        {/* ---- The collapse: six things become one ---------------------
            The stage sticks with CSS rather than a scripted pin. GSAP's pin
            works by injecting a spacer element, which lands when the motion
            chunk finishes loading and shoves the document: measured at 0.034 of
            layout shift on a phone. position:sticky inside a track of known
            height puts that space in the layout at first paint, so the scripted
            layer only ever touches opacity and transform. */}
        <div id="mk-collapse-track" className="relative h-[240svh] border-t mk-rule">
        <section id="mk-collapse" className="sticky top-0 flex h-[100svh] items-center overflow-hidden">
          <div className="mx-auto w-full max-w-[1400px] px-5 sm:px-10">
            <p className="mk-eyebrow mk-muted mb-10">Where the work lives today</p>
            <div className="grid gap-x-10 gap-y-3 sm:grid-cols-2">
              {SCATTER.map((s) => (
                <p key={s} className="mk-scatter-item mk-h2 mk-muted">{s}</p>
              ))}
            </div>
            <div id="mk-one" className="pointer-events-none absolute inset-0 flex items-center justify-center px-5">
              <p className="mk-display mk-accent text-center">One tab.</p>
            </div>
          </div>
        </section>
        </div>

        {/* ---- The five areas ------------------------------------------ */}
        <section id="how" className="border-t mk-rule py-20 sm:py-32">
          <div className="mx-auto max-w-[1400px] px-5 sm:px-10">
            <div className="mk-reveal max-w-[18rem]">
              <p className="mk-eyebrow mk-accent mb-5">The shape of it</p>
              <h2 className="mk-h2">Five areas. Every business runs on the same five.</h2>
            </div>
            <div className="mt-14 divide-y divide-[var(--mk-line)] border-y mk-rule">
              {AREAS.map((a) => (
                <div key={a.key} className="mk-area grid gap-2 py-7 sm:grid-cols-[10rem_1fr] sm:gap-10 sm:py-9">
                  <h3 className="mk-h3 mk-accent">{a.key}</h3>
                  <p className="mk-lead mk-muted max-w-[38rem]">{a.line}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- The flow that pays for the software --------------------- */}
        <section className="border-t mk-rule py-20 sm:py-32">
          <div className="mx-auto max-w-[1400px] px-5 sm:px-10">
            <div className="mk-reveal max-w-[19rem]">
              <p className="mk-eyebrow mk-accent mb-5">The part that pays for itself</p>
              <h2 className="mk-h2">Hours in. Invoice out.</h2>
            </div>
            <ol className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
              {[
                ['01', 'Run the timer', 'Every card carries a timer. Hit play when you start, and the hours attach themselves to the client without you writing anything down.'],
                ['02', 'Pull the month', 'Raise an invoice straight from tracked time. Klippy prices it at the rate you set for that client and marks those hours billed, so nothing goes out twice.'],
                ['03', 'Get paid', 'It sends with a pay link, chases itself when it goes late, and tells you the moment the money lands.'],
              ].map(([n, title, body]) => (
                <li key={n} className="mk-reveal">
                  <p className="num mk-accent mb-4 text-sm">{n}</p>
                  <h3 className="mk-h3 mb-3">{title}</h3>
                  <p className="mk-muted leading-relaxed">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---- What it does unattended --------------------------------- */}
        <section className="border-t mk-rule py-20 sm:py-32">
          <div className="mx-auto max-w-[1400px] px-5 sm:px-10">
            <div className="mk-reveal max-w-[21rem]">
              <p className="mk-eyebrow mk-accent mb-5">While you are doing the actual work</p>
              <h2 className="mk-h2">It keeps running without you.</h2>
            </div>
            <div className="mt-14 grid gap-x-10 gap-y-12 sm:grid-cols-2">
              {AUTOMATIC.map(([title, body]) => (
                <div key={title} className="mk-reveal">
                  <h3 className="mk-h3 mb-3 flex items-start gap-3">
                    <Check size={20} className="mt-1 shrink-0 mk-accent" aria-hidden="true" />
                    {title}
                  </h3>
                  <p className="mk-muted max-w-[35rem] leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- Built here ---------------------------------------------- */}
        <section className="border-t mk-rule py-20 sm:py-32">
          <div className="mx-auto max-w-[1400px] px-5 sm:px-10">
            <div className="mk-reveal grid gap-10 sm:grid-cols-[1fr_1fr] sm:gap-20">
              <div>
                <p className="mk-eyebrow mk-accent mb-5">Built where you work</p>
                <h2 className="mk-h2">Rands, PayFast, WhatsApp.</h2>
              </div>
              <div className="space-y-5">
                <p className="mk-lead mk-muted">
                  Klippy was built for a South African business and it shows in the details: invoices in
                  rands with the VAT worked out, PayFast pay links, and reminders that reach a client on
                  WhatsApp rather than sitting unread in an inbox.
                </p>
                <p className="mk-muted leading-relaxed">
                  Run more than one business from the same login, give each its own brand, invoice
                  numbers and bank account, and let your clients see their own invoices and hosting in a
                  portal that carries your name instead of ours.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Close ---------------------------------------------------- */}
        <section id="pricing" className="border-t mk-rule py-24 sm:py-36">
          <div className="mx-auto max-w-[1400px] px-5 text-center sm:px-10">
            <div className="mk-reveal">
              <h2 className="mk-display mx-auto max-w-[11rem]">Start with one client.</h2>
              <p className="mk-lead mk-muted mx-auto mt-8 max-w-[30rem]">
                Free to start, no card. Add a client, run a timer on something real, and send the
                invoice that comes out of it. That is the whole trial.
              </p>
              <div className="mt-10 flex flex-wrap justify-center gap-3">
                <button onClick={onGetStarted} className="mk-cta flex items-center gap-2 rounded-xl px-8 py-4 text-base">
                  Start free <ArrowRight size={17} />
                </button>
                <button onClick={onLogin} className="rounded-xl border mk-rule px-8 py-4 text-base hover:bg-white/5">
                  I have an account
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t mk-rule">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-4 px-5 py-8 pb-safe sm:px-10">
          <div className="flex items-center gap-2.5">
            <div className="grid h-7 w-7 place-items-center rounded-md bg-[var(--mk-accent)] text-xs font-bold text-[var(--mk-ink)]">K</div>
            <span className="text-sm mk-muted">Klippy, by Mondobase</span>
          </div>
          <button onClick={onGetStarted} className="text-sm mk-accent hover:underline">Start free</button>
        </div>
      </footer>
    </div>
  );
}
