import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthBrand } from '../layout/AuthLayout';
import { Field, FormActions, Notice, useDocumentTitle } from '../components/ui';

/**
 * 로그인 (FR-242). OIDC 버튼은 서버가 켜져 있다고 알려줄 때만 보인다 (FR-219).
 *
 * 카드 틀(P17 설계서 J.3.1·J.6) — 카드 위의 제품 이름이 h1이고 카드 안의 "로그인"이 h2다(시험이 둘을 본다). 칸은 위 라벨(J.5.4)이고
 * **눈 모양 단추를 두지 않는다** — 두면 "비밀번호"로 칸을 찾는 이름 찾기가 그 단추에도 걸린다(J.5.3·J.8 6).
 */
export function LoginPage() {
  const { me, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oidc, setOidc] = useState(false);
  useDocumentTitle('로그인');

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
    <>
      <AuthBrand heading />
      <div className="auth-card">
        <h2>로그인</h2>
        {error && <Notice kind="error">{error}</Notice>}
        <form className="form-stack" onSubmit={submit}>
          <Field id="username" label="아이디">
            <input id="username" className="w-full" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </Field>
          <Field id="password" label="비밀번호">
            <input id="password" className="w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>
          <FormActions>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? '확인 중…' : '로그인'}
            </button>
          </FormActions>
        </form>
        {oidc && (
          <>
            <p className="auth-or">또는</p>
            {/* 서버 리다이렉트를 타야 하므로 fetch가 아니라 링크다 — 모양만 단추다(J.5.2 a.btn) */}
            <a className="btn" href="/api/auth/oidc/start">
              사내 계정으로 로그인
            </a>
          </>
        )}
      </div>
      <p className="auth-links">
        <Link to="/signup">가입 요청</Link> · <Link to="/find-account">아이디·비밀번호 찾기</Link> ·{' '}
        <Link to="/find-account/root">시스템 관리자 아이디 찾기</Link>
      </p>
    </>
  );
}
