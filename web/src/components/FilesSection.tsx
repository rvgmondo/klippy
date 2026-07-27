import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Trash2, Download } from 'lucide-react';
import { apiGet, apiDelete } from '../lib/api';

interface TaskFile {
  id: number;
  originalName: string;
  filesize: number;
  mimeType: string;
  uploadedAt: string;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function FilesSection({ taskId }: { taskId: number }) {
  const qc = useQueryClient();
  const key = ['task', taskId, 'files'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{ files: TaskFile[] }>(`/tasks/${taskId}/files`),
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      // No Content-Type header: the browser sets the multipart boundary itself.
      const res = await fetch(`/api/v1/tasks/${taskId}/files`, {
        method: 'POST', body: form, credentials: 'same-origin',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Upload failed.');
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/files/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Attachments</label>
        <button onClick={() => inputRef.current?.click()} disabled={uploading}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-60">
          <Paperclip size={12} /> {uploading ? 'Uploading...' : 'Attach file'}
        </button>
        <input ref={inputRef} type="file" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      </div>

      {error && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{error}</div>}

      <div className="space-y-1">
        {(data?.files ?? []).map((f) => (
          <div key={f.id} className="group flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-slate-900">
            <Paperclip size={12} className="shrink-0 text-slate-500" />
            <a href={`/api/v1/files/${f.id}/download`}
              className="flex-1 truncate text-slate-200 hover:text-violet-300 hover:underline">
              {f.originalName}
            </a>
            <span className="text-slate-500">{fmtSize(f.filesize)}</span>
            <a href={`/api/v1/files/${f.id}/download`} title="Download"
              className="hidden text-slate-500 hover:text-slate-200 group-hover:block"><Download size={12} /></a>
            <button onClick={() => del.mutate(f.id)} title="Delete"
              className="hidden text-slate-500 hover:text-red-400 group-hover:block"><Trash2 size={12} /></button>
          </div>
        ))}
        {(data?.files.length ?? 0) === 0 && (
          <p className="px-1 text-xs text-slate-500">No attachments yet. 15MB max per file.</p>
        )}
      </div>
    </div>
  );
}
