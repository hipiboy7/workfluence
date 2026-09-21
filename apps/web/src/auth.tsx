import type { MeView } from '@workfluence/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, api } from './api';

export type Me = MeView;

type AuthState = {
  me: Me | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/auth/me'));
    } catch (e) {
      // 401은 "로그인 안 됨"이지 오류가 아니다. 그 밖의 실패만 콘솔에 남긴다
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setMe(await api<Me>('/api/auth/login', { method: 'POST', json: { username, password } }));
  }, []);

  const logout = useCallback(async () => {
    await api<void>('/api/auth/logout', { method: 'POST' });
    setMe(null);
  }, []);

  const value = useMemo(() => ({ me, loading, login, logout, refresh }), [me, loading, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider 밖에서 useAuth를 호출했다');
  return ctx;
}

/**
 * 로그인 필수 (FR-244, FR-245).
 * 비밀번호 변경이 강제된 계정은 변경 화면 밖으로 나가지 못한다 — 서버도 같은 판정을 한다.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">로그인 상태 확인 중…</p>;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}
