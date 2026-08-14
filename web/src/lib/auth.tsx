import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost, apiPatch, ApiError } from './api';
import type { Account, User } from './types';

interface Session { user: User; account: Account; }
interface AuthState {
  user: User | null;
  account: Account | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (accountName: string, name: string, email: string, password: string) => Promise<void>;
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

  const login = async (email: string, password: string) => {
    apply(await apiPost<Session>('/auth/login', { email, password }));
  };
  const signup = async (accountName: string, name: string, email: string, password: string) => {
    apply(await apiPost<Session>('/auth/signup', { accountName, name, email, password }));
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
    <Ctx.Provider value={{ user, account, loading, login, signup, logout, refresh, updateAccount }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
