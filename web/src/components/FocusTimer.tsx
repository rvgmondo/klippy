import { useEffect, useRef, useState, type ReactNode } from 'react';
import { notify } from './ConfirmDialog';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { X, Play, Pause, RotateCcw, PictureInPicture2, Square, Clock } from 'lucide-react';
import { apiPost } from '../lib/api';
import { useRunningTimer } from './TimerChip';
import { Modal } from './Modal';

type Mode = 'countdown' | 'stopwatch';
const PRESETS = [15, 25, 50];

// Document Picture-in-Picture isn't in TS's lib yet.
interface DocPiP { requestWindow(opts?: { width?: number; height?: number }): Promise<Window>; window: Window | null }
function getDocPiP(): DocPiP | null {
  return (window as unknown as { documentPictureInPicture?: DocPiP }).documentPictureInPicture ?? null;
}

/** Clone the app's styles + theme attributes into a popped-out window. */
function primeWindow(w: Window) {
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    w.document.head.appendChild(node.cloneNode(true));
  }
  const root = document.documentElement;
  w.document.documentElement.dataset.theme = root.dataset.theme ?? 'dark';
  w.document.documentElement.dataset.accent = root.dataset.accent ?? 'violet';
  w.document.body.style.margin = '0';
  w.document.body.style.background = 'var(--app-bg, #0b0f17)';
}

const fmt = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export function FocusTimer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: running } = useRunningTimer();
  const workTimer = running?.current ?? null;

  const [mode, setMode] = useState<Mode>('countdown');
  const [target, setTarget] = useState(25 * 60);   // countdown length
  const [secs, setSecs] = useState(25 * 60);        // remaining (countdown) or elapsed (stopwatch)
  const [active, setActive] = useState(false);
  const [custom, setCustom] = useState('');
  const [done, setDone] = useState(false);
  const [pip, setPip] = useState<Window | null>(null);
  const ref = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    ref.current = window.setInterval(() => {
      setSecs((s) => {
        if (mode === 'stopwatch') return s + 1;
        if (s <= 1) { setActive(false); setDone(true); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => { if (ref.current) window.clearInterval(ref.current); };
  }, [active, mode]);

  function startCountdown(mins: number) {
    setMode('countdown'); setTarget(mins * 60); setSecs(mins * 60); setDone(false); setActive(true);
  }
  function startStopwatch() {
    setMode('stopwatch'); setSecs(0); setDone(false); setActive(true);
  }
  function reset() {
    setActive(false); setDone(false);
    setSecs(mode === 'countdown' ? target : 0);
  }

  const stopWork = () => apiPost('/timer/stop').then(() => {
    qc.invalidateQueries({ queryKey: ['timer'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  });

  async function popOut() {
    const docPiP = getDocPiP();
    if (!docPiP) {
      // Fallback: a plain popup window (movable, just not always-on-top).
      const w = window.open('', 'klippy-timer', 'width=260,height=320');
      if (w) { primeWindow(w); w.addEventListener('pagehide', () => setPip(null)); setPip(w); }
      else notify('Your browser blocked the popup. Allow popups for Klippy to float the timer.', 'error');
      return;
    }
    const w = await docPiP.requestWindow({ width: 260, height: 320 });
    primeWindow(w);
    w.addEventListener('pagehide', () => setPip(null));
    setPip(w);
  }

  const pct = mode === 'countdown' && target > 0 ? (1 - secs / target) * 100 : 0;

  const body: ReactNode = (
    <div className="flex h-full w-full flex-col bg-slate-950 p-4 text-slate-100">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Focus</span>
        <div className="flex items-center gap-1">
          {!pip && (
            <button onClick={popOut} title="Pop out to a floating window"
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <PictureInPicture2 size={15} />
            </button>
          )}
          <button onClick={onClose} title="Close" className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={15} /></button>
        </div>
      </div>

      <div className="relative mx-auto mb-4 grid h-32 w-32 place-items-center">
        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="45" fill="none" stroke="var(--color-slate-800,#1e293b)" strokeWidth="6" />
          {mode === 'countdown' && (
            <circle cx="50" cy="50" r="45" fill="none" stroke="var(--color-violet-500,#8b5cf6)" strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 45}`} strokeDashoffset={`${2 * Math.PI * 45 * (1 - pct / 100)}`} />
          )}
        </svg>
        <span className={`text-2xl font-semibold num ${done ? 'text-green-400' : 'text-slate-100'}`}>{fmt(secs)}</span>
      </div>

      {done && <p className="mb-2 text-center text-xs text-green-400">Time's up.</p>}

      <div className="mb-3 flex justify-center gap-2">
        {PRESETS.map((m) => (
          <button key={m} onClick={() => startCountdown(m)}
            className={`rounded-lg px-3 py-1 text-xs ${mode === 'countdown' && target === m * 60 ? 'bg-violet-600 text-[var(--accent-ink)]' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {m}m
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-center gap-2">
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Custom min"
          className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center text-xs text-slate-100 outline-none focus:border-violet-500" />
        <button onClick={() => { const n = parseInt(custom, 10); if (n > 0) startCountdown(n); }}
          className="rounded-lg bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700">Set</button>
      </div>

      <div className="flex justify-center gap-2">
        {active ? (
          <button onClick={() => setActive(false)} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500">
            <Pause size={15} /> Pause
          </button>
        ) : (
          <button onClick={() => (secs > 0 || mode === 'stopwatch' ? setActive(true) : startCountdown(25))}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500">
            <Play size={15} /> Start
          </button>
        )}
        <button onClick={startStopwatch} title="Count up from zero"
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">
          Just start
        </button>
        <button onClick={reset} title="Reset" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">
          <RotateCcw size={15} />
        </button>
      </div>

      {/* The running work timer, so you can watch/stop billable time from the same widget. */}
      {workTimer && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-2.5 py-2">
          <Clock size={13} className="shrink-0 text-green-400" />
          <span className="min-w-0 flex-1 truncate text-xs text-green-200">{workTimer.taskTitle ?? 'Tracking task'}</span>
          <WorkClock startTime={workTimer.startTime} />
          <button onClick={stopWork} title="Stop task timer" className="grid h-5 w-5 place-items-center rounded text-green-300 hover:bg-green-500/20">
            <Square size={11} fill="currentColor" />
          </button>
        </div>
      )}
    </div>
  );

  // When popped out, render into the floating window; otherwise a modal.
  if (pip) return createPortal(body, pip.document.body);

  return (
    <Modal onClose={onClose} variant="panel">
      <div className="w-full max-w-xs overflow-hidden rounded-2xl border border-slate-700">
        {body}
      </div>
    </Modal>
  );
}

function WorkClock({ startTime }: { startTime: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startTime).getTime()) / 1000));
  return <span className="shrink-0 text-xs font-medium num text-green-300">{fmt(secs)}</span>;
}
