import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../auth';
import { PasswordInput } from '../../components/PasswordInput';

/**
 * 첫 페이지: 로그인 + 계정 찾기(ID·PWD) + 그 외(신규 가입·담당자 확인).
 * 버튼 순서는 사용자 지시(2026-09-15, prototype-v3 1번): 로그인 바로 아래 ID·PWD 찾기, 맨 아래 신규 가입·담당자 확인.
 */
export function LandingPage() {
  const { me, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && me) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>workfluence</h1>
        <p className="muted">사내 위키 (프로토타입)</p>
        <form onSubmit={onSubmit}>
          <label htmlFor="login-username">사용자명</label>
          <input id="login-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
          <label htmlFor="login-password">비밀번호</label>
          <PasswordInput id="login-password" value={password} onChange={setPassword} autoComplete="current-password" required />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="primary wide" disabled={busy}>
            {busy ? '확인 중…' : '로그인'}
          </button>
        </form>
        <div className="landing-links recover">
          <Link className="button" to="/find-id">
            ID 찾기
          </Link>
          <Link className="button" to="/recover-password">
            PWD 찾기
          </Link>
        </div>
        <hr className="divider" />
        <div className="landing-links secondary">
          <Link className="button" to="/signup">
            신규 가입
          </Link>
          <Link className="button" to="/contact">
            담당자 확인
          </Link>
        </div>
      </div>
    </div>
  );
}
