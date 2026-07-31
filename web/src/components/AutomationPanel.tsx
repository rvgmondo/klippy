import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { apiGet, apiPost, apiPatch } from '../lib/api';
import { ErrorNote } from './ErrorNote';

interface Job {
  name: string; label: string; description: string; hour: number;
  enabled: boolean;
  lastRunOn: string | null; lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null; lastMessage: string | null;
}
interface Automation { mailConfigured: boolean; jobs: Job[] }

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

  if (error) return <ErrorNote error={error} onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Klippy runs these itself, once a day. Nothing to set up, and no cron jobs to write.
      </p>

      {data && !data.mailConfigured && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          Email is not configured on the server, so these run but deliver nothing. Add
          <span className="text-amber-200"> SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM </span>
          to the app environment and restart it.
        </div>
      )}

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
