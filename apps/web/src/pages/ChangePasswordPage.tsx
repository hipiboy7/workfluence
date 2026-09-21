import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';

/** 비밀번호 변경 (FR-207). 변경 강제 상태면 여기서 나갈 수 없다 */
export function ChangePasswordPage() {
  const { me, refresh, logout } = useAuth();
  const nav = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/change-password', { method: 'POST', json: { currentPassword, newPassword } });
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <form className="card" onSubmit={submit}>
        <h2>비밀번호 변경</h2>
        {me?.mustChangePassword && <p className="badge fail">비밀번호를 변경해야 계속할 수 있다.</p>}
        <label htmlFor="cp-cur">현재 비밀번호</label>
        <input id="cp-cur" type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <label htmlFor="cp-new">새 비밀번호</label>
        <input id="cp-new" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" required />
        <p className="muted small">8자 이상, 영문 대·소문자·숫자·특수문자 중 2종 이상</p>
        {error && <p className="badge fail" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? '바꾸는 중…' : '변경'}</button>
        <button type="button" className="secondary" onClick={() => void logout().then(() => nav('/login'))}>로그아웃</button>
      </form>
    </main>
  );
}
