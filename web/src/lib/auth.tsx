import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost, apiPatch, ApiError } from './api';
import type { Account, User } from './types';

interface Session { user: User; account: Account; }
/** Login either signs you in, or hands back a short-lived ticket and asks for a code. */
export type LoginResult = { twoFactorRequired: true; ticket: string } | undefined;
interface AuthState {
  user: User | null;
  account: Account | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verify2fa: (ticket: string, code: string) => Promise<void>;
  signup: (accountName: string, name: string, email: string, password: string, extras?: { blueprint?: string; currency?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateAccount: (patch: Partial<Pick<Account, 'name' | 'folderLabelSingular' | 'folderLabelPlural' | 'currency'>>) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = (s: Session) => { setUser(s.user); setAccount(s.account); };

  async function refresh() {
    try {
      const s = await apiGet<Session>('/auth/me');
      apply(s);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setUser(null); setAccount(null); }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await apiPost<Session | { twoFactorRequired: true; ticket: string }>('/auth/login', { email, password });
    if ('twoFactorRequired' in res) return res;
    apply(res);
    return undefined;
  };
  const verify2fa = async (ticket: string, code: string) => {
    apply(await apiPost<Session>('/auth/2fa/verify', { ticket, code }));
  };
  const signup = async (accountName: string, name: string, email: string, password: string, extras?: { blueprint?: string; currency?: string }) => {
    apply(await apiPost<Session>('/auth/signup', { accountName, name, email, password, ...extras }));
  };
  const logout = async () => {
    // Always clear the local session, even if the server call fails, so the
    // sign-out button can never appear to do nothing.
    try {
      await apiPost('/auth/logout');
    } catch {
      // ignore: cookie may already be gone / network hiccup
    } finally {
      setUser(null);
      setAccount(null);
    }
  };
  const updateAccount = async (patch: Partial<Pick<Account, 'name' | 'folderLabelSingular' | 'folderLabelPlural' | 'currency'>>) => {
    const res = await apiPatch<{ account: Account }>('/account', patch);
    setAccount(res.account);
  };

  return (
    <Ctx.Provider value={{ user, account, loading, login, verify2fa, signup, logout, refresh, updateAccount }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
