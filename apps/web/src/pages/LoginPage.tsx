import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';

/** 로그인 (FR-242). OIDC 버튼은 서버가 켜져 있다고 알려줄 때만 보인다 (FR-219) */
export function LoginPage() {
  const { me, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oidc, setOidc] = useState(false);

  useEffect(() => {
    api<{ oidcEnabled: boolean }>('/api/auth/config')
      .then((c) => setOidc(c.oidcEnabled))
      .catch(() => setOidc(false));
  }, []);

  if (me) return <Navigate to={me.mustChangePassword ? '/change-password' : (loc.state?.from ?? '/')} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <h1>workfluence</h1>
      <form className="card" onSubmit={submit}>
        <h2>로그인</h2>
        <label htmlFor="username">아이디</label>
        <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        <label htmlFor="password">비밀번호</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        {error && <p className="badge fail" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? '확인 중…' : '로그인'}</button>
        {oidc && (
          // 서버 리다이렉트를 타야 하므로 fetch가 아니라 링크다
          <a className="button-like" href="/api/auth/oidc/start">사내 계정으로 로그인</a>
        )}
        <p className="muted small">
          <Link to="/signup">가입 요청</Link> · <Link to="/find-account">아이디·비밀번호 찾기</Link>
        </p>
      </form>
    </main>
  );
}
