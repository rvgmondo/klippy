const BASE = '/api/v1';

export class ApiError extends Error {
  status: number;
  /** The database driver's own message, when the API could identify one. */
  cause?: string;
  constructor(message: string, status: number, cause?: string) {
    super(message);
    this.status = status;
    this.cause = cause;
  }
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  // Only declare a JSON content-type when we actually send a body. Fastify
  // rejects an empty body that claims to be JSON (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which would break every bodyless POST (logout, timer stop, ...).
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> ?? {}) };
  if (opts.body !== undefined && opts.body !== null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(BASE + path, { ...opts, headers, credentials: 'same-origin' });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const body = data as { error?: string; cause?: string } | null;
    const msg = body?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, body?.cause);
  }
  return data as T;
}

export const apiGet = <T>(p: string) => api<T>(p);
export const apiPost = <T>(p: string, body?: unknown) =>
  api<T>(p, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
export const apiPatch = <T>(p: string, body: unknown) =>
  api<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
export const apiPut = <T>(p: string, body: unknown) =>
  api<T>(p, { method: 'PUT', body: JSON.stringify(body) });
export const apiDelete = <T>(p: string) => api<T>(p, { method: 'DELETE' });
