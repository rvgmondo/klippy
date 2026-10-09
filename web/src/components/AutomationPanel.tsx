import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Play, CheckCircle2, AlertTriangle, Clock, XCircle, Copy } from 'lucide-react';
import { apiGet, apiPost, apiPatch } from '../lib/api';
import { ErrorNote } from './ErrorNote';

interface Job {
  name: string; label: string; description: string; hour: number;
  enabled: boolean;
  lastRunOn: string | null; lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null; lastMessage: string | null;
}
interface Check { key: string; label: string; state: 'ok' | 'warn' | 'bad'; detail: string }
interface Automation { mailConfigured: boolean; jobs: Job[]; checks?: Check[]; cronCommand?: string }

function whenText(job: Job): string {
  if (!job.lastRunAt) return 'Has not run yet';
  const d = new Date(job.lastRunAt);
  const today = new Date().toISOString().slice(0, 10);
  const day = job.lastRunOn === today ? 'today' : job.lastRunOn;
  return `Last ran ${day} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * What the app does on its own, and proof that it did. These used to be cPanel cron
 * jobs someone had to write curl commands for; the app runs them itself now, so this
 * is the place to check they are happening and to force one early.
 */
export function AutomationPanel() {
  const qc = useQueryClient();
  const { data, error, refetch } = useQuery({
    queryKey: ['automation'],
    queryFn: () => apiGet<Automation>('/automation'),
    retry: false,
  });

  const run = useMutation({
    mutationFn: (name: string) => apiPost<{ ok: boolean; message: string }>(`/automation/${name}/run`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation'] }),
  });
  const toggle = useMutation({
    mutationFn: (v: { name: string; enabled: boolean }) => apiPatch(`/automation/${v.name}`, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation'] }),
  });

  const [copied, setCopied] = useState(false);
  if (error) return <ErrorNote error={error} onRetry={() => refetch()} />;
  const checks = data?.checks ?? [];
  const problems = checks.filter((c) => c.state !== 'ok').length;

  return (
    <div className="space-y-4">
      {/* Everything below runs by itself, and does nothing at all when the server is
          missing a setting. This says so before a client goes unchased. */}
      {checks.length > 0 && (
        <div className={`rounded-xl border p-3 ${problems ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-emerald-500/30 bg-emerald-500/[0.06]'}`}>
          <div className="mb-2 text-sm font-medium text-slate-100">
            {problems ? `Set-up check: ${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention` : 'Set-up check: everything is in place'}
          </div>
          <ul className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-xs">
                {c.state === 'ok' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-400" />
                  : c.state === 'warn' ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
                    : <XCircle size={14} className="mt-0.5 shrink-0 text-red-400" />}
                <span><span className="font-medium text-slate-200">{c.label}.</span> <span className="text-slate-400">{c.detail}</span></span>
              </li>
            ))}
          </ul>
          {data?.cronCommand && checks.some((c) => (c.key === 'cron' || c.key === 'missed') && c.state !== 'ok') && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] text-slate-500">In cPanel, Cron Jobs, every 15 minutes. Put your CRON_SECRET where it says YOUR_CRON_SECRET.</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-slate-950 px-2 py-1.5 text-[11px] text-slate-300">{data.cronCommand}</code>
                <button onClick={() => { void navigator.clipboard?.writeText(data.cronCommand!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
                  <Copy size={11} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Klippy runs these once a day, after the hour shown. The wake-up cron makes sure that happens even when nobody has opened the app.
      </p>

      <div className="space-y-2">
        {(data?.jobs ?? []).map((job) => (
          <div key={job.name} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{job.label}</span>
                  <span className="num text-[11px] text-slate-500">
                    daily, around {String(job.hour).padStart(2, '0')}:00
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500">{job.description}</p>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                  {job.lastStatus === 'failed' ? (
                    <span className="flex items-center gap-1 text-red-400"><AlertTriangle size={11} /> Failed</span>
                  ) : job.lastRunAt ? (
                    <span className="flex items-center gap-1 text-violet-300"><CheckCircle2 size={11} /> {whenText(job)}</span>
                  ) : (
                    <span className="flex items-center gap-1 text-slate-500"><Clock size={11} /> {whenText(job)}</span>
                  )}
                  {job.lastMessage && <span className="text-slate-500">{job.lastMessage}</span>}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button onClick={() => run.mutate(job.name)} disabled={run.isPending}
                  title="Run it now"
                  className="flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                  <Play size={11} /> Run now
                </button>
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-violet-600"
                    checked={job.enabled}
                    onChange={(e) => toggle.mutate({ name: job.name, enabled: e.target.checked })} />
                  On
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>

      {run.data && (
        <p className="text-[11px] text-slate-400">Last manual run: {run.data.message}</p>
      )}
    </div>
  );
}
