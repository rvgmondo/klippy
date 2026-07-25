import { useEffect, useRef, useState } from 'react';
import { X, Play, Pause, RotateCcw } from 'lucide-react';

const PRESETS = [15, 25, 50];

export function FocusTimer({ onClose }: { onClose: () => void }) {
  const [minutes, setMinutes] = useState(25);
  const [remaining, setRemaining] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const ref = useRef<number | null>(null);

  useEffect(() => {
    if (running) {
      ref.current = window.setInterval(() => {
        setRemaining((r) => { if (r <= 1) { setRunning(false); return 0; } return r - 1; });
      }, 1000);
    }
    return () => { if (ref.current) window.clearInterval(ref.current); };
  }, [running]);

  function setPreset(m: number) { setMinutes(m); setRemaining(m * 60); setRunning(false); }
  function reset() { setRemaining(minutes * 60); setRunning(false); }

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');
  const pct = minutes > 0 ? (1 - remaining / (minutes * 60)) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl border border-slate-700 bg-slate-900 p-6 text-center" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Focus timer</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>

        <div className="relative mx-auto mb-5 grid h-40 w-40 place-items-center">
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="45" fill="none" stroke="#1e293b" strokeWidth="6" />
            <circle cx="50" cy="50" r="45" fill="none" stroke="#8b5cf6" strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 45}`} strokeDashoffset={`${2 * Math.PI * 45 * (1 - pct / 100)}`} />
          </svg>
          <span className="text-3xl font-semibold tabular-nums text-slate-100">{mm}:{ss}</span>
        </div>

        <div className="mb-4 flex justify-center gap-2">
          {PRESETS.map((m) => (
            <button key={m} onClick={() => setPreset(m)}
              className={`rounded-lg px-3 py-1 text-xs ${minutes === m ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
              {m}m
            </button>
          ))}
        </div>

        <div className="flex justify-center gap-2">
          <button onClick={() => setRunning((r) => !r)}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">
            {running ? <><Pause size={15} /> Pause</> : <><Play size={15} /> Start</>}
          </button>
          <button onClick={reset} title="Reset"
            className="grid h-9 w-9 place-items-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
