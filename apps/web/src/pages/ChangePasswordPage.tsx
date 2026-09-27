import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePasswordRuleText } from '../components/usePasswordRules';

/** 비밀번호 변경 (FR-207). 변경 강제 상태면 여기서 나갈 수 없다 */
export function ChangePasswordPage() {
  const { me, refresh, logout } = useAuth();
  const nav = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ruleText = usePasswordRuleText();

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

  // **사내 계정은 여기서 바꾸지 않는다** (P13 FR-1471) — 비밀번호가 없다. 예전에는 폼이 떠서 누르면 "사용자를 찾을 수 없다"가 떴다
  if (me && !me.hasPassword) {
    return (
      <main className="shell">
        <section className="card">
          <h2>비밀번호 변경</h2>
          <p>사내 계정으로 로그인했다. 비밀번호는 사내 계정(IdP)에서 바꾼다.</p>
          <button type="button" onClick={() => nav('/')}>홈으로</button>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <form className="card" onSubmit={submit}>
        <h2>비밀번호 변경</h2>
        {me?.mustChangePassword && <p className="badge fail">비밀번호를 변경해야 계속할 수 있다.</p>}
        <label htmlFor="cp-cur">현재 비밀번호</label>
        <input id="cp-cur" type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <label htmlFor="cp-new">새 비밀번호</label>
        <input id="cp-new" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" required />
        <p className="muted small">{ruleText}</p>
        {error && <p className="badge fail" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? '바꾸는 중…' : '변경'}</button>
        <button type="button" className="secondary" onClick={() => void logout().then(() => nav('/login'))}>로그아웃</button>
      </form>
    </main>
  );
}
